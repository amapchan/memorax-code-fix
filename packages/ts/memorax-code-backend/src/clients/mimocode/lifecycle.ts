import { attachDeploymentFailure, deploymentFailure } from "../../../../memorax-code-adapter-common/src/deployment-failure.mjs";
import type {
  AdapterLifecycleParticipant,
  AdapterPluginLifecycleReport,
  AdapterReport,
} from "../../lifecycle/participant.js";

export const mimoCodeAdapterLifecycle = {
  async status({ argv, serviceOptions, backendUrl }) {
    try {
      return (await loadMiMoCodePluginInstaller()).readMiMoCodePluginStatus(
        mimoCodeAdapterOptions(argv, serviceOptions.home, backendUrl),
      );
    } catch (error) {
      return { ok: false, action: "status", failure: deploymentFailure(error, "deploy"), error: error instanceof Error ? error.message : String(error) };
    }
  },
  async prepareEnable({ argv, serviceOptions, backendUrl }) {
    try {
      return (await loadMiMoCodePluginInstaller()).ensureMiMoCodePluginInstalled(
        mimoCodeAdapterOptions(argv, serviceOptions.home, backendUrl),
      );
    } catch (error) {
      return {
        ok: false,
        action: "enable",
        failure: deploymentFailure(error, "deploy"), error: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && "stage" in error && typeof error.stage === "string"
          ? { stage: error.stage } : {}),
        ...(error instanceof Error && "code" in error && typeof error.code === "string"
          ? { errorCode: error.code } : {}),
      };
    }
  },
  async disable({ argv, serviceOptions }) {
    try {
      return (await loadMiMoCodePluginInstaller()).disableMiMoCodePlugin(
        mimoCodeAdapterOptions(argv, serviceOptions.home),
      );
    } catch (error) {
      return { ok: false, action: "disable", failure: deploymentFailure(error, "deploy"), error: error instanceof Error ? error.message : String(error) };
    }
  },
  async remove({ argv, serviceOptions }) {
    try {
      return (await loadMiMoCodePluginInstaller()).removeMiMoCodePluginInstallation(
        mimoCodeAdapterOptions(argv, serviceOptions.home),
      );
    } catch (error) {
      return {
        ok: false,
        action: "mimocode-plugin-remove",
        reason: "plugin_remove_failed",
        failure: deploymentFailure(error, "plugin-remove"), message: error instanceof Error ? error.message : String(error),
      };
    }
  },
} satisfies AdapterLifecycleParticipant<AdapterPluginLifecycleReport>;

function mimoCodeAdapterOptions(
  argv: string[],
  memoraxCodeHome: string | undefined,
  backendUrl?: string,
): Record<string, unknown> {
  const mimoCodeConfigDir = argValue(argv, "--mimocode-config-dir");
  return {
    ...(mimoCodeConfigDir ? { mimoCodeConfigDir } : {}),
    memoraxCodeHome,
    ...(backendUrl ? { backendUrl } : {}),
  };
}

async function loadMiMoCodePluginInstaller(): Promise<{
  ensureMiMoCodePluginInstalled: (options: Record<string, unknown>) => AdapterReport;
  disableMiMoCodePlugin: (options: Record<string, unknown>) => AdapterReport;
  removeMiMoCodePluginInstallation: (options: Record<string, unknown>) => AdapterPluginLifecycleReport;
  readMiMoCodePluginStatus: (options: Record<string, unknown>) => AdapterReport;
}> {
  return await import(new URL("../../../../memorax-code-mimocode-adapter/src/plugin-install.mjs", import.meta.url).href)
    .catch((error) => { throw attachDeploymentFailure(error, "adapter-load"); });
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
