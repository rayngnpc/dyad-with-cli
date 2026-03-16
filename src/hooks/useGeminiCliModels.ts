import { useCallback } from "react";
import { useAtom } from "jotai";
import {
  geminiCliModelsAtom,
  geminiCliModelsLoadingAtom,
  geminiCliModelsErrorAtom,
} from "@/atoms/localModelsAtoms";
import { ipc } from "@/ipc/types";

export function useGeminiCliModels() {
  const [models, setModels] = useAtom(geminiCliModelsAtom);
  const [loading, setLoading] = useAtom(geminiCliModelsLoadingAtom);
  const [error, setError] = useAtom(geminiCliModelsErrorAtom);

  /**
   * Load local models from Gemini CLI
   */
  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const { models: modelList } = await ipc.languageModel.listGeminiCliModels();
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
  }, [setModels, setError, setLoading]);

  return {
    models,
    loading,
    error,
    loadModels,
  };
}
