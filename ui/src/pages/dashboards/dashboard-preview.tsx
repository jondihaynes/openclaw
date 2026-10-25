import { createErrorBoundary } from "@solidjs/signals";
import { lazy, Loading } from "solid-js";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";

const BoardDocument = lazy(() => import("../../components/board/board-document.tsx"), {
  export: "OpenClawBoardDocument",
});

export function DashboardPreview(props: {
  gatewaySnapshot?: ApplicationGatewaySnapshot;
  sessionKey?: string;
  agentId?: string;
}) {
  const content = createErrorBoundary(
    () => (
      <Loading>
        <BoardDocument
          passive={true}
          gatewaySnapshot={props.gatewaySnapshot}
          preparedSession={{ sessionKey: props.sessionKey ?? "", agentId: props.agentId }}
        />
      </Loading>
    ),
    (error) => (
      <div class="dashboard-preview__error">
        {t("dashboardDocument.loadFailed", { error: formatUiError(error()) })}
      </div>
    ),
  );
  return <openclaw-dashboard-preview>{content()}</openclaw-dashboard-preview>;
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-dashboard-preview": HTMLAttributes<HTMLElement>;
    }
  }
}
