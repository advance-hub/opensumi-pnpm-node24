// rc-notification 3.x does not publish TypeScript declarations. In a hoisted
// pnpm workspace TypeScript can otherwise discover the incompatible 5.x types
// used by the notebook stack.
declare module 'rc-notification' {
  const Notification: any;
  export default Notification;
}
