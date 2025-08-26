import { useCallback, useState, useEffect, useMemo } from "react";
import cx from "classnames";

type ReactProps = Record<string, any> | undefined;
type WebComponentProps<T extends ReactProps> = NonNullable<T> & {
  class?: string;
  style?: Record<string, string | number>;
};

export const buildWebComponentProps = <T extends ReactProps>(
  props: T
): WebComponentProps<T> => {
  if (!props) return {} as WebComponentProps<T>;

  const [boolProps, commonProps] = Object.keys(props).reduce(
    ([boolProps, commonProps], key) => {
      const value = props[key];
      if (typeof value === "boolean") {
        if (value) return [{ ...boolProps, [key]: value }, commonProps];
        else return [boolProps, commonProps];
      } else {
        return [boolProps, { ...commonProps, [key]: value }];
      }
    },
    [{} as Record<string, boolean>, {} as Record<string, any>]
  );

  const webComponentProps = {
    ...boolProps,
    ...commonProps,
    ...("className" in commonProps ? { class: commonProps.className } : {}),
  };

  return webComponentProps as WebComponentProps<T>;
};

const loadComponent = async (
  name: string,
  importCallback?: () => Promise<any>
) => {
  if (!customElements.get(name)) {
    if (importCallback) {
      await importCallback();
      await customElements.whenDefined(name);
    } else {
      throw new Error(`Web component "${name}" is not defined`);
    }
  }

  return true;
};

export const useWebComponent = <T extends Record<string, any> | undefined>({
  props,
  ...rest
}: { props: T; className?: string } & (
  | {
      components: {
        name: string;
        importCallback?: () => Promise<any>;
      }[];
    }
  | {
      name: string;
      importCallback?: () => Promise<any>;
    }
)): { isDefined: boolean; props: WebComponentProps<T> } => {
  const [isDefined, setIsDefined] = useState(false);
  const load = useCallback(async () => {
    if ("components" in rest) {
      for await (const { name, importCallback } of rest.components) {
        await loadComponent(name, importCallback);
      }
    } else {
      await loadComponent(rest.name, rest.importCallback);
    }

    setIsDefined(true);
  }, []);

  useEffect(() => {
    load();
  }, []);

  const _props = useMemo(() => {
    return buildWebComponentProps({
      ...props,
      className: cx(rest.className, props?.className ?? ""),
    });
  }, [props]);

  return { isDefined, props: _props };
};
