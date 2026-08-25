import React from 'react';

import { ClickOutside, ContextMenuTrigger } from '@opensumi/ide-components';
import { useAutorun, useInjectable } from '@opensumi/ide-core-browser';
import { MenuActionList } from '@opensumi/ide-core-browser/lib/components/actions';
import { IBrowserCtxMenu } from '@opensumi/ide-core-browser/lib/menu/next/renderer/ctxmenu/browser';
import { IIconService } from '@opensumi/ide-theme/lib/common/theme.service';

export const CtxMenu = () => {
  const ctxMenuService = useInjectable<IBrowserCtxMenu>(IBrowserCtxMenu);
  const visible = useAutorun(ctxMenuService.visibleObservable);

  const iconService = useInjectable<IIconService>(IIconService);

  const handleClick = React.useCallback(() => {
    ctxMenuService.hide(false);
  }, []);

  const onClickOutSide = React.useCallback(() => {
    if (visible) {
      ctxMenuService.hide(true);
    }
  }, [visible]);

  // todo: 缓存上一次点击 visible 完成 toggle 效果
  return (
    <ContextMenuTrigger
      popupVisible={visible}
      point={ctxMenuService.point || {}}
      popupClassName='point-popup'
      popup={
        <ClickOutside mouseEvents={['click', 'contextmenu']} onOutsideClick={onClickOutSide}>
          <MenuActionList
            data={ctxMenuService.menuNodes}
            afterClick={handleClick}
            context={ctxMenuService.context}
            iconService={iconService}
            renderSubMenuTitle={ctxMenuService.renderSubMenuTitle}
            renderMenuItem={ctxMenuService.renderMenuItem}
          />
        </ClickOutside>
      }
    />
  );
};

CtxMenu.displayName = 'CtxMenu';
