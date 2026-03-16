import { useCallback } from "react";
import { useAtom } from "jotai";
import {
  openCodeModelsAtom,
  openCodeModelsLoadingAtom,
  openCodeModelsErrorAtom,
} from "@/atoms/localModelsAtoms";
import { ipc } from "@/ipc/types";

export function useOpenCodeModels() {
  const [models, setModels] = useAtom(openCodeModelsAtom);
  const [loading, setLoading] = useAtom(openCodeModelsLoadingAtom);
  const [error, setError] = useAtom(openCodeModelsErrorAtom);

  /**
   * Load local models from OpenCode CLI
   */
  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const { models: modelList } = await ipc.languageModel.listOpenCodeModels();
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
  }, [setModels, setError, setLoading]);

  return {
    models,
    loading,
    error,
    loadModels,
  };
}
