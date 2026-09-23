// Browser page translators (Google Translate, Chrome/Edge built-in translation) replace React's text
// nodes with <font> wrappers. React then calls removeChild/insertBefore on nodes that are no longer
// direct children and throws "Failed to execute 'insertBefore' on 'Node'", unmounting the whole app
// (white screen). Skipping those mismatched operations keeps the UI alive.
export function installDomGuard() {
  if (typeof Node !== 'function' || !Node.prototype) return;

  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (child.parentNode !== this) return child;
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function <T extends Node>(this: Node, newNode: T, referenceNode: Node | null): T {
    if (referenceNode && referenceNode.parentNode !== this) return newNode;
    return originalInsertBefore.call(this, newNode, referenceNode) as T;
  };
}
