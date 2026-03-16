import { registerOllamaHandlers } from "./local_model_ollama_handler";
import { registerLMStudioHandlers } from "./local_model_lmstudio_handler";
import { registerGeminiCliHandlers } from "./local_model_gemini_cli_handler";
import { registerOpenCodeHandlers } from "./local_model_opencode_handler";
import { registerLettaHandlers } from "./local_model_letta_handler";

export function registerLocalModelHandlers() {
  registerOllamaHandlers();
  registerLMStudioHandlers();
  registerGeminiCliHandlers();
  registerOpenCodeHandlers();
  registerLettaHandlers();
}
