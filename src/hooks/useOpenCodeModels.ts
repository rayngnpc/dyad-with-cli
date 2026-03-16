import { useCallback } from "react";
import { useAtom } from "jotai";
import {
  openCodeModelsAtom,
  openCodeModelsLoadingAtom,
  openCodeModelsErrorAtom,
} from "@/atoms/localModelsAtoms";
import { IpcClient } from "@/ipc/ipc_client";

export function useOpenCodeModels() {
  const [models, setModels] = useAtom(openCodeModelsAtom);
  const [loading, setLoading] = useAtom(openCodeModelsLoadingAtom);
  const [error, setError] = useAtom(openCodeModelsErrorAtom);

  const ipcClient = IpcClient.getInstance();

  /**
   * Load local models from OpenCode CLI
   */
  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const modelList = await ipcClient.listLocalOpenCodeModels();
      setModels(modelList);
      setError(null);

      return modelList;
    } catch (error) {
      console.error("Error loading OpenCode models:", error);
      setError(error instanceof Error ? error : new Error(String(error)));
      return [];
    } finally {
      setLoading(false);
    }
  }, [ipcClient, setModels, setError, setLoading]);

  return {
    models,
    loading,
    error,
    loadModels,
  };
}
