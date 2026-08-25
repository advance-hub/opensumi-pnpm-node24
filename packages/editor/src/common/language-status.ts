import {
  Event,
  IAccessibilityInformation,
  IDisposable,
  Severity,
  StatusBarHoverCommand,
} from '@opensumi/ide-core-common';

import { LanguageSelector } from './language';

import type { ITextModel } from '@opensumi/ide-monaco/lib/common';

export const ILanguageStatusService = Symbol('ILanguageStatusService');
export interface ILanguageStatusService {
  onDidChange: Event<void>;

  addStatus(status: ILanguageStatus): IDisposable;

  getLanguageStatus(model: ITextModel): ILanguageStatus[];
}

export interface ILanguageStatus {
  readonly id: string;
  readonly name: string;
  readonly selector: LanguageSelector;
  readonly severity: Severity;
  readonly label: string;
  readonly detail: string;
  readonly source: string;
  readonly command?: StatusBarHoverCommand;
  readonly accessibilityInfo: IAccessibilityInformation | undefined;
  readonly busy: boolean;
}
