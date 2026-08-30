import { ElementHandle } from '@playwright/test';

import { OpenSumiApp } from './app';
import { OpenSumiMenu } from './menu';

export class OpenSumiContextMenu extends OpenSumiMenu {
  selector = '.rc-trigger-popup:not(.rc-trigger-popup-hidden) .kt-inner-menu';

  public static async openAt(app: OpenSumiApp, x: number, y: number): Promise<OpenSumiContextMenu> {
    await app.page.mouse.move(x, y);
    await app.page.mouse.click(x, y, { button: 'right' });
    return OpenSumiContextMenu.returnWhenVisible(app);
  }

  public static async open(
    app: OpenSumiApp,
    element: () => Promise<ElementHandle<SVGElement | HTMLElement>>,
  ): Promise<OpenSumiContextMenu> {
    const elementHandle = await element();
    try {
      await elementHandle.click({ button: 'right', timeout: 2000 });
    } catch (error) {
      if (!(await elementHandle.isVisible())) {
        throw error;
      }
      // Pinned tabs can move between scroll regions while their context menu
      // is requested. Dispatch to the resolved tab after a short real-click
      // attempt so a transient overlay cannot consume the entire test timeout.
      await elementHandle.dispatchEvent('contextmenu', {
        bubbles: true,
        button: 2,
        buttons: 2,
        cancelable: true,
      });
    }
    return OpenSumiContextMenu.returnWhenVisible(app);
  }

  private static async returnWhenVisible(app: OpenSumiApp): Promise<OpenSumiContextMenu> {
    const menu = new OpenSumiContextMenu(app);
    await menu.waitForVisible();
    return menu;
  }
}
