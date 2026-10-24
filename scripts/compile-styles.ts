import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import postcss, { type ChildNode } from "postcss";
import { FORMS_CLASSES } from "../src/tailwind/components/form";
import { components, type ComponentName } from "../src/tailwind/components/index";
import { tokens } from "../src/tailwind/theme";
import type { CompiledComponent, CompiledRule, CssInJs, Layer, Styles } from "../src/tailwind/types";

const root = fileURLToPath(new URL("..", import.meta.url));

// Like daisyUI, the components are shipped as plain CSS: nothing is left for `@apply` in the user's project, so
// Tailwind's `prefix(tw)` only has to prefix the class names. The theme is inlined, `calc(0.25rem * 4)` instead of
// `var(--spacing)` (which is `--tw-spacing` with a prefix). Only the design tokens stay variables, renamed to the
// plugin's own `vui` ones (`bg-primary-600` → `var(--color-vui-primary-600)`), which it sets from the user's theme.
const INLINE_THEME = `@import "tailwindcss/theme.css" theme(inline);
@import "tailwindcss/utilities.css";`;
const THEME = `${INLINE_THEME}
@theme inline {
${tokens.map(({ themeVariable, variable }) => `  ${themeVariable}: var(${variable});`).join("\n")}
}`;

const tokenVariables = new Set(tokens.map(({ variable }) => variable));

/** Token variables the rules read, e.g. `--color-gray-300`. */
const getVariables = (rules: CompiledRule[]) => [
  ...new Set(
    [...JSON.stringify(rules).matchAll(/var\((--[\w-]+)/g)]
      .map((match) => match[1])
      .filter((variable) => tokenVariables.has(variable)),
  ),
];

const compileCss = async (css: string, candidates: string[] = []) => {
  const compiler = await compile(css, { base: root, onDependency: () => {} });
  return postcss.parse(compiler.build(candidates));
};

/** Splits a selector list on its top-level commas: `a, :where(b, c)` → `a`, `:where(b, c)`. */
const splitSelector = (selector: string) => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (char === "(" || char === "[") {
      depth++;
    } else if (char === ")" || char === "]") {
      depth--;
    } else if (char === "," && depth === 0) {
      parts.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts;
};

/**
 * A compiled rule's selector relative to the component's one. When a rule is nothing but variants, Tailwind moves
 * them out of it: `.tr { @apply even:bg-gray-100 }` compiles to `.tr:nth-child(even) { … }`, nested back as
 * `&:nth-child(even)`. Relative, because the plugin splits the selector list between `addBase` and `addComponents`.
 */
const nest = (selector: string, compiled: string) => {
  // already nested: `&:hover`, `:where(& > :not(:last-child))`
  if (compiled.includes("&")) {
    return compiled;
  }
  const parts = splitSelector(selector);
  const compiledParts = splitSelector(compiled);
  const suffixes = compiledParts.map((part, i) => {
    const base = parts[i];
    return base !== undefined && part.startsWith(base) ? part.slice(base.length) : undefined;
  });
  const [suffix] = suffixes;
  if (compiledParts.length !== parts.length || suffix === undefined || suffixes.some((other) => other !== suffix)) {
    throw new Error(`[versoly-ui] "${compiled}" can't be nested in "${selector}"`);
  }
  return `&${suffix}`;
};

/**
 * CSS nodes → CSS-in-JS. Repeated keys become arrays, which Tailwind turns back into repeated declarations / rules.
 * With `selector`, the nodes are that rule's compiled output: its own declarations are inlined and every other rule,
 * also inside at-rules like `@media (hover: hover) { .tr:hover { … } }`, is nested relative to it.
 */
const toObject = (nodes: ChildNode[] = [], selector?: string): CssInJs => {
  const css: CssInJs = {};
  const add = (key: string, value: string | CssInJs) => {
    const current = css[key];
    if (current === undefined) {
      css[key] = value;
    } else {
      css[key] = [...(Array.isArray(current) ? current : [current]), value] as string[] | CssInJs[];
    }
  };

  const walk = (nodes: ChildNode[] = []) => {
    for (const node of nodes) {
      if (node.type === "decl") {
        add(node.prop, node.important ? `${node.value} !important` : node.value);
      } else if (node.type === "rule") {
        if (selector === undefined) {
          add(node.selector, toObject(node.nodes));
        } else if (node.selector === selector) {
          walk(node.nodes);
        } else {
          add(nest(selector, node.selector), toObject(node.nodes));
        }
      } else if (node.type === "atrule") {
        add(`@${node.name} ${node.params}`, toObject(node.nodes, selector));
      }
    }
  };
  walk(nodes);
  return css;
};

const getProperties = (css: postcss.Root) =>
  Object.fromEntries(
    css.nodes.flatMap((node) =>
      node.type === "atrule" && node.name === "property" ? [[node.params, toObject(node.nodes)]] : [],
    ),
  );

const compileComponent = async (name: ComponentName): Promise<CompiledComponent> => {
  const rules = (Object.entries(components[name]) as [Layer, Styles][]).flatMap(([layer, styles]) =>
    Object.entries(styles).map(([selector, value]) => ({ selector, layer, value })),
  );

  // each rule in its own marker layer, to find its output
  const input = rules
    .map(({ selector, value }, i) =>
      typeof value === "string" ? `@layer vui-${i} { ${selector} { @apply ${value}; } }` : "",
    )
    .join("\n");
  const css = await compileCss(`${THEME}\n${input}`);

  const compiled: CompiledRule[] = rules.map(({ selector, layer, value }, i) => {
    if (typeof value !== "string") {
      return { selector, layer, css: value };
    }
    const marker = css.nodes.find(
      (node) => node.type === "atrule" && node.name === "layer" && node.params === `vui-${i}`,
    );
    if (!marker || marker.type !== "atrule") {
      throw new Error(`[versoly-ui] ${name}: "${selector}" wasn't compiled`);
    }
    return {
      selector,
      layer,
      css: toObject(marker.nodes, selector),
    };
  });

  const component: CompiledComponent = {
    rules: compiled,
    properties: getProperties(css),
    variables: getVariables(compiled),
  };
  return name === "form" ? withForms(component) : component;
};

/** Adds the @tailwindcss/forms classes the `form` component is built on, in the weakest layer. */
const withForms = async (component: CompiledComponent): Promise<CompiledComponent> => {
  // literal colors: the forms plugin puts them into SVG data URIs, where a `var()` doesn't work
  const css = await compileCss(`${INLINE_THEME}\n@plugin "@tailwindcss/forms" { strategy: class; }`, FORMS_CLASSES);

  const rules: CompiledRule[] = css.nodes.flatMap((node): CompiledRule[] => {
    if (node.type === "rule" && !node.selector.startsWith(":root")) {
      return [{ selector: node.selector, layer: "forms", css: toObject(node.nodes) }];
    }
    // `@media (forced-colors: active) { .form-checkbox:checked { … } }` → `.form-checkbox:checked { @media … { … } }`
    if (node.type === "atrule" && node.name === "media") {
      return (node.nodes ?? []).flatMap((rule) =>
        rule.type === "rule"
          ? [{ selector: rule.selector, layer: "forms", css: { [`@media ${node.params}`]: toObject(rule.nodes) } }]
          : [],
      );
    }
    return [];
  });

  return {
    rules: [...rules, ...component.rules],
    properties: { ...getProperties(css), ...component.properties },
    variables: component.variables,
  };
};

export const compileStyles = async () =>
  Object.fromEntries(
    await Promise.all(
      (Object.keys(components) as ComponentName[]).map(async (name) => [name, await compileComponent(name)] as const),
    ),
  ) as Record<ComponentName, CompiledComponent>;
