import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MigrationProviderPlugin } from "../plugins/types.js";
import { createNonExitingRuntime } from "../runtime.js";
import { offerPostInstallMigrations } from "./setup.post-install-migration.js";

const migrationProviders = vi.hoisted(() => vi.fn<() => MigrationProviderPlugin[]>(() => []));
vi.mock("../plugins/migration-provider-runtime.js", () => ({
  withPluginMigrationProviders: async (
    _params: unknown,
    run: (providers: MigrationProviderPlugin[]) => Promise<unknown>,
  ) => await run(migrationProviders()),
}));
const resolveOwnership = vi.hoisted(() =>
  vi.fn<
    (params: { contract: string; value?: string }) => {
      pluginIds: string[];
      bundledCompatPluginIds: string[];
    }
  >(),
);
vi.mock("../plugins/manifest-contract-runtime.js", () => ({
  resolveManifestContractRuntimePluginResolution: resolveOwnership,
}));
vi.mock("../commands/migrate/context.js", () => ({
  createMigrationLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../config/paths.js", () => ({ resolveStateDir: () => "/tmp/state" }));
const migrateDefaultCommand = vi.hoisted(() =>
  vi.fn<typeof import("../commands/migrate.js").migrateDefaultCommand>(),
);
vi.mock("../commands/migrate.js", () => ({ migrateDefaultCommand }));

const ttyMock = createCliTtyMock([process.stdin]);
function buildProvider(overrides: Partial<MigrationProviderPlugin> = {}): MigrationProviderPlugin {
  return {
    id: "codex",
    label: "Codex",
    plan: vi.fn<MigrationProviderPlugin["plan"]>(),
    apply: vi.fn<MigrationProviderPlugin["apply"]>(),
    detect: vi.fn(async () => ({ found: true, source: "/home/user/.codex" })),
    ...overrides,
  };
}
function runOffer(overrides: Partial<Parameters<typeof offerPostInstallMigrations>[0]> = {}) {
  return offerPostInstallMigrations({
    config: {},
    runtime: createNonExitingRuntime(),
    prompter,
    installedPluginIds: ["codex"],
    ...overrides,
  });
}

let provider: MigrationProviderPlugin;
let prompter: ReturnType<typeof createWizardPrompter>;
beforeEach(() => {
  vi.clearAllMocks();
  provider = buildProvider();
  prompter = createWizardPrompter();
  migrationProviders.mockReset().mockReturnValue([provider]);
  resolveOwnership.mockReset().mockReturnValue({
    pluginIds: ["codex"],
    bundledCompatPluginIds: [],
  });
  migrateDefaultCommand.mockReset();
  ttyMock.set(true);
});
afterEach(() => {
  ttyMock.restore();
});

it("returns unchanged without loading providers when no plugins were installed", async () => {
  const config: OpenClawConfig = { plugins: { entries: { codex: { enabled: true } } } };
  const result = await runOffer({ config, installedPluginIds: [] });
  expect(migrationProviders).not.toHaveBeenCalled();
  expect(migrateDefaultCommand).not.toHaveBeenCalled();
  expect(result.config).toBe(config);
});

it("excludes unowned, absent, low-confidence, and failed detections from migration offers", async () => {
  const unowned = buildProvider({ id: "unowned" });
  const absent = buildProvider({ id: "absent", detect: vi.fn(async () => ({ found: false })) });
  const low = buildProvider({
    id: "low",
    detect: vi.fn(async () => ({ found: true, confidence: "low" as const })),
  });
  const failed = buildProvider({
    id: "failed",
    detect: vi.fn(async () => {
      throw new Error("detect failure");
    }),
  });
  migrationProviders.mockReturnValue([unowned, absent, low, failed]);
  resolveOwnership.mockImplementation(({ value }) => ({
    pluginIds: value === "unowned" ? ["other"] : ["codex"],
    bundledCompatPluginIds: [],
  }));
  await runOffer();
  expect(unowned.detect).not.toHaveBeenCalled();
  expect(prompter.confirm).not.toHaveBeenCalled();
  expect(migrateDefaultCommand).not.toHaveBeenCalled();
});

it.each([false, true])(
  "continues unchanged after an accepted migration (failure=%s)",
  async (fails) => {
    vi.mocked(prompter.confirm).mockResolvedValue(true);
    if (fails) {
      migrateDefaultCommand.mockRejectedValueOnce(new Error("boom"));
    }
    const result = await runOffer();
    expect(migrateDefaultCommand).toHaveBeenCalledOnce();
    expect(result).toEqual({ config: {} });
  },
);

it("shows provider-owned import scope before asking and respects a decline", async () => {
  const description = "Import Example skills. Example conversations are not imported.";
  migrationProviders.mockReturnValue([buildProvider({ label: "Example", description })]);
  await runOffer();
  expect(prompter.note).toHaveBeenCalledWith(
    `${description}\n\nYou will review import options and confirm before applying.`,
    "Example migration",
  );
  expect(prompter.note).toHaveBeenCalledBefore(vi.mocked(prompter.confirm));
  expect(prompter.confirm).toHaveBeenCalledWith({
    message: "Review migration from Example at /home/user/.codex?",
    initialValue: false,
  });
  expect(migrateDefaultCommand).not.toHaveBeenCalled();
});

it("returns migrated config patches without mutating the input or replacing sibling settings", async () => {
  const originalSettings = { appServer: { sandbox: "workspace-write" } };
  const inputConfig: OpenClawConfig = {
    plugins: { entries: { codex: { enabled: true, config: originalSettings } } },
  };
  migrateDefaultCommand.mockResolvedValueOnce({
    providerId: "codex",
    source: "/home/user/.codex",
    summary: {
      total: 1,
      planned: 0,
      migrated: 1,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items: [
      {
        id: "config:codex-plugins",
        kind: "config",
        action: "merge",
        status: "migrated",
        details: {
          path: ["plugins", "entries", "codex"],
          value: { enabled: true, config: { codexPlugins: { enabled: true } } },
        },
      },
    ],
  });
  vi.mocked(prompter.confirm).mockResolvedValue(true);
  const result = await runOffer({ config: inputConfig });
  expect(migrateDefaultCommand).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({
      provider: "codex",
      configOverride: inputConfig,
      configPatchMode: "return",
      suppressPlanLog: true,
    }),
    provider,
  );
  expect(result.config).not.toBe(inputConfig);
  expect(result.config.plugins?.entries?.codex?.config).toEqual({
    appServer: { sandbox: "workspace-write" },
    codexPlugins: { enabled: true },
  });
  expect(inputConfig.plugins?.entries?.codex?.config).toEqual({
    appServer: { sandbox: "workspace-write" },
  });
});

it.each(["flag", "stdin"])(
  "never prompts or applies when %s selects non-interactive mode",
  async (mode) => {
    ttyMock.set(mode !== "stdin");
    await runOffer({ nonInteractive: mode === "flag" });
    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(migrateDefaultCommand).not.toHaveBeenCalled();
  },
);
