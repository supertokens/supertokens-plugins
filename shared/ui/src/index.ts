// prevent trying to define web awesome components that are already defined
// if we don't do this, an error will be thrown because the component is already defined and the components won't be usable
const originalDefineFn = CustomElementRegistry.prototype.define;
CustomElementRegistry.prototype.define = function (elementName: string, impl: any, options: ElementDefinitionOptions) {
  const registeredCustomElement = customElements.get(elementName);
  const isWebAwesomeComponent = elementName.startsWith("wa-");
  if (isWebAwesomeComponent && registeredCustomElement) return; // do nothig

  return originalDefineFn.apply(this, [elementName, impl, options]);
};

export * from "./hooks";
export * from "./components";
