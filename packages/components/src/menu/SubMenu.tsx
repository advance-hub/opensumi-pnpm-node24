import { SubMenuProps as RCSubMenuProps, SubMenu as RcSubMenu } from 'rc-menu';
import React from 'react';

interface TitleEventEntity {
  key: string;
  domEvent: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>;
}

export interface SubMenuProps extends RCSubMenuProps {
  rootPrefixCls?: string;
  className?: string;
  disabled?: boolean;
  title?: React.ReactNode;
  style?: React.CSSProperties;
  onTitleClick?: (e: TitleEventEntity) => void;
  onTitleMouseEnter?: (e: TitleEventEntity) => void;
  onTitleMouseLeave?: (e: TitleEventEntity) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
  popupOffset?: [number, number];
  popupClassName?: string;
  ref?: React.Ref<HTMLLIElement> | undefined;
}

const SubMenu: React.FC<SubMenuProps> & { isSubMenu: number } = (props) => {
  const { popupClassName } = props;
  return <RcSubMenu {...props} popupClassName={popupClassName} />;
};

// rc-menu uses this marker to recognize nested menu components.
SubMenu.isSubMenu = 1;

export default SubMenu;
