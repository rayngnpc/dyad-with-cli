import { useCallback } from "react";
import { useAtom } from "jotai";
import {
  lettaModelsAtom,
  lettaModelsLoadingAtom,
  lettaModelsErrorAtom,
} from "@/atoms/localModelsAtoms";
import { IpcClient } from "@/ipc/ipc_client";

export function useLettaModels() {
  const [models, setModels] = useAtom(lettaModelsAtom);
  const [loading, setLoading] = useAtom(lettaModelsLoadingAtom);
  const [error, setError] = useAtom(lettaModelsErrorAtom);

  const ipcClient = IpcClient.getInstance();

  /**
   * Load local models from Letta CLI
   */
  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const modelList = await ipcClient.listLocalLettaModels();
      setModels(modelList);
      setError(null);

      return modelList;
    } catch (error) {
      console.error("Error loading Letta models:", error);
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
