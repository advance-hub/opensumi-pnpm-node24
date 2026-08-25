import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const VIEWPORT_MARGIN = 4;

export interface ContextMenuTriggerProps {
  popup: React.ReactNode;
  popupVisible: boolean;
  point?: {
    pageX?: number;
    pageY?: number;
  };
  popupClassName?: string;
  zIndex?: number;
}

/**
 * A small point-anchored portal for context menus.
 *
 * The previous third-party trigger depended on React's removed legacy context
 * API and findDOMNode. OpenSumi controls visibility itself, so a full trigger
 * state machine is unnecessary here.
 */
export const ContextMenuTrigger: React.FC<ContextMenuTriggerProps> = ({
  popup,
  popupVisible,
  point,
  popupClassName,
  zIndex = 1050,
}) => {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const anchorX = point?.pageX ?? 0;
  const anchorY = point?.pageY ?? 0;
  const [position, setPosition] = useState({ left: anchorX, top: anchorY });

  useLayoutEffect(() => {
    if (!popupVisible || !popupRef.current) {
      return;
    }

    const updatePosition = () => {
      const rect = popupRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN);
      const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN);
      const nextPosition = {
        left: Math.min(Math.max(anchorX, VIEWPORT_MARGIN), maxLeft),
        top: Math.min(Math.max(anchorY, VIEWPORT_MARGIN), maxTop),
      };
      setPosition((current) =>
        current.left === nextPosition.left && current.top === nextPosition.top ? current : nextPosition,
      );
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [anchorX, anchorY, popup, popupVisible]);

  if (!popupVisible || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      ref={popupRef}
      className={['rc-trigger-popup', 'rc-trigger-popup-placement-bottomLeft', popupClassName]
        .filter(Boolean)
        .join(' ')}
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        zIndex,
      }}
    >
      {popup}
    </div>,
    document.body,
  );
};

ContextMenuTrigger.displayName = 'ContextMenuTrigger';
