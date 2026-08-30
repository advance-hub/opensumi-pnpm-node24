import { OpenSumiApp } from './app';
import { OpenSumiContextMenu } from './context-menu';
import { OpenSumiPanel } from './panel';

type TerminalType = 'bash' | 'zsh' | 'Javascript Debug Terminal';

export class OpenSumiTerminalView extends OpenSumiPanel {
  constructor(app: OpenSumiApp) {
    super(app, 'TERMINAL');
  }

  async waitForTerminalReady() {
    await this.waitForVisible(10000);
    const terminalSelector = `${this.viewSelector} .xterm-screen, ${this.viewSelector} .xterm-rows, ${this.viewSelector} textarea.xterm-helper-textarea`;
    await this.page.waitForFunction(
      (selector) =>
        Array.from(document.querySelectorAll(selector)).some((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        }),
      terminalSelector,
      { timeout: 10000 },
    );
    this.view = await this.page.$(this.viewSelector);
  }

  async sendText(text: string) {
    const visible = await this.isVisible();
    if (!visible) {
      await this.open();
    }
    await this.waitForTerminalReady();
    await this.focus();
    // xterm keeps its input textarea at zero size, so Playwright's `:visible`
    // pseudo-class must be applied to the live terminal root instead.
    const textarea = this.page
      .locator(`${this.viewSelector} .xterm:visible`)
      .last()
      .locator('textarea.xterm-helper-textarea');
    await textarea.evaluate((element) => element.focus());
    await this.page.waitForFunction(
      (selector) => document.activeElement?.matches(selector),
      `${this.viewSelector} textarea.xterm-helper-textarea:focus`,
    );
    await this.page.keyboard.type(text);
    await this.app.page.keyboard.press('Enter');
  }

  async createTerminalByType(type: TerminalType) {
    const button = this.page.locator(`${this.viewSelector} [title="Create terminal by type"]:visible`).last();
    await button.waitFor();
    // The terminal title and toolbar can briefly overlap on Linux. Trigger the
    // same element action directly so a transient overlay cannot swallow it.
    await button.evaluate((element) => (element as HTMLElement).click());
    const menu = new OpenSumiContextMenu(this.app);
    await menu.waitForVisible();
    await menu.clickMenuItem(type);

    // 新建终端后，需要等待一段时间，否则会出现终端未创建完成的情况
    await this.app.page.waitForTimeout(5000);
  }
}
