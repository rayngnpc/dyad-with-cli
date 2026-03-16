import { atom } from "jotai";
import { type LocalModel } from "@/ipc/ipc_types";

export const localModelsAtom = atom<LocalModel[]>([]);
export const localModelsLoadingAtom = atom<boolean>(false);
export const localModelsErrorAtom = atom<Error | null>(null);

export const lmStudioModelsAtom = atom<LocalModel[]>([]);
export const lmStudioModelsLoadingAtom = atom<boolean>(false);
export const lmStudioModelsErrorAtom = atom<Error | null>(null);

export const geminiCliModelsAtom = atom<LocalModel[]>([]);
export const geminiCliModelsLoadingAtom = atom<boolean>(false);
export const geminiCliModelsErrorAtom = atom<Error | null>(null);

export const openCodeModelsAtom = atom<LocalModel[]>([]);
export const openCodeModelsLoadingAtom = atom<boolean>(false);
export const openCodeModelsErrorAtom = atom<Error | null>(null);

export const lettaModelsAtom = atom<LocalModel[]>([]);
export const lettaModelsLoadingAtom = atom<boolean>(false);
export const lettaModelsErrorAtom = atom<Error | null>(null);
