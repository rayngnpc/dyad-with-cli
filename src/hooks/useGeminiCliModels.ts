import { useCallback } from "react";
import { useAtom } from "jotai";
import {
  geminiCliModelsAtom,
  geminiCliModelsLoadingAtom,
  geminiCliModelsErrorAtom,
} from "@/atoms/localModelsAtoms";
import { IpcClient } from "@/ipc/ipc_client";

export function useGeminiCliModels() {
  const [models, setModels] = useAtom(geminiCliModelsAtom);
  const [loading, setLoading] = useAtom(geminiCliModelsLoadingAtom);
  const [error, setError] = useAtom(geminiCliModelsErrorAtom);

  const ipcClient = IpcClient.getInstance();

  /**
   * Load local models from Gemini CLI
   */
  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const modelList = await ipcClient.listLocalGeminiCliModels();
      setModels(modelList);
      setError(null);

      return modelList;
    } catch (error) {
      console.error("Error loading Gemini CLI models:", error);
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
