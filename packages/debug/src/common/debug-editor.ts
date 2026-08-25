import type { ICodeEditor as IMonacoCodeEditor } from '@opensumi/ide-monaco/lib/common';
export const DebugEditor = Symbol('DebugEditor');
export type DebugEditor = IMonacoCodeEditor;
