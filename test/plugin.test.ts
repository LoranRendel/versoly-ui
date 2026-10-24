import postcss from "postcss";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  build,
  classesOf,
  componentNames,
  hasRule,
  layerOf,
  plugin,
  ruleIndex,
  utilitiesLayer,
  variable,
  variables,
} from "./helpers";

const hasClass = (css: string, name: string) => new RegExp(`\\.${name}(?![\\w-])`).test(css);

const TW = '@import "tailwindcss" prefix(tw);';
const DAISYUI = '@plugin "daisyui";';

/** Custom properties declared outside Tailwind's theme and `@property` fallbacks. */
const declaredVariables = (css: string) => {
  const names = new Set<string>();
  postcss.parse(css).walkDecls(/^--/, (decl) => {
    for (let node = decl.parent; node && node.type !== "root"; node = node.parent) {
      if (node.type === "atrule" && node.name === "layer" && ["theme", "properties"].includes(node.params)) {
        return;
      }
    }
    names.add(decl.prop);
  });
  return [...names];
};

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("without options", () => {
  it.each(componentNames)("adds the %s component", async (name) => {
    const classes = classesOf(name);
    const css = await build(plugin(), classes);

    for (const name of classes) {
      expect(css, `.${name}`).toSatisfy((css: string) => hasClass(css, name));
    }
  });

  it("adds global styles", async () => {
    const css = await build(plugin());

    expect(hasRule(css, "body")).toBe(true);
    expect(hasRule(css, "h1")).toBe(true);
    expect(hasRule(css, "html :where(a)")).toBe(true);
    expect(hasRule(css, '[data-toggle="dropdown"]')).toBe(true);
    expect(variable(css, "--vui-svg-caret-down")).toMatch(/^url\(/);
    expect(variable(css, "--vui-svg-arrow-down")).toMatch(/^url\(/);
  });

  it("adds the color variables", async () => {
    const css = await build(plugin());

    for (const name of ["primary", "secondary", "info", "danger"]) {
      expect(variable(css, `--color-vui-${name}`), name).toMatch(/^oklch\(/);
      for (const shade of [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]) {
        expect(variable(css, `--color-vui-${name}-${shade}`), `${name}-${shade}`).toMatch(/^oklch\(/);
      }
    }
    expect(variable(css, "--color-vui-dark")).toMatch(/^oklch\(/);
    expect(variable(css, "--color-vui-muted")).toMatch(/^oklch\(/);
  });

  it("adds vui- theme utilities that read the variables", async () => {
    const css = await build(plugin(), ["text-vui-primary", "bg-vui-primary-600", "text-vui-dark", "rounded-vui-field"]);

    expect(css).toMatch(/\.text-vui-primary \{\s*color: var\(--color-vui-primary\);/);
    expect(css).toMatch(/\.bg-vui-primary-600 \{\s*background-color: var\(--color-vui-primary-600\);/);
    expect(css).toMatch(/\.text-vui-dark \{\s*color: var\(--color-vui-dark\);/);
    expect(css).toMatch(/\.rounded-vui-field \{\s*border-radius: var\(--radius-vui-field\);/);
  });

  it("adds the @tailwindcss/forms classes", async () => {
    const css = await build(plugin(), ["form-input", "form-checkbox"]);

    expect(css).toMatch(/\.form-input \{[^}]*appearance: none/);
    expect(css).toMatch(/\.form-checkbox:checked \{/);
  });

  it("generates only the classes used in the markup", async () => {
    const css = await build(plugin(), ["btn"]);

    expect(hasRule(css, ".btn")).toBe(true);
    expect(hasRule(css, ".card")).toBe(false);
    expect(hasRule(css, ".btn-primary")).toBe(false);
  });

  it("registers the --tw-* variables the components use", async () => {
    // `.card` has `shadow-md`, the markup has no shadow utility
    const css = await build(plugin("include: card;"), ["card"]);

    expect(css).toMatch(/@property --tw-shadow \{/);
    expect(css).toMatch(/@property --tw-ring-shadow \{/);
  });

  it("doesn't warn", async () => {
    await build(plugin());

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("compiled CSS", () => {
  const allClasses = componentNames.flatMap(classesOf);

  it("defines every variable the components read", async () => {
    // with `prefix(tw)` Tailwind's theme variables are `--tw-…`, so these have to come from the plugin.
    // `text-*` are the link colors' Tailwind utilities, which read Tailwind's variables.
    const classes = allClasses.filter((name) => !name.startsWith("text-")).map((name) => `tw:${name}`);
    const css = await build(plugin(), classes, TW);
    const used = [...new Set([...utilitiesLayer(css).matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]))];

    expect(used.length).toBeGreaterThan(10);
    expect(used.filter((name) => !name.startsWith("--tw-") && variable(css, name) === undefined)).toEqual([]);
  });

  it("reads the design tokens from variables", async () => {
    const css = await build(plugin(), ["btn", "card", "badge", "alert"]);

    expect(css).toMatch(/\.btn \{[^}]*border-radius: var\(--radius-vui-field\)/);
    expect(css).toMatch(/\.card \{[^}]*border-radius: var\(--radius-vui-box\)/);
    expect(css).toMatch(/\.badge \{[^}]*border-radius: var\(--radius-vui-selector\)/);
    expect(css).toMatch(/\.alert \{[^}]*background-color: var\(--color-vui-gray-100\)/);
  });

  it("doesn't leave @apply behind", async () => {
    const css = await build(plugin(), allClasses);

    expect(css).not.toContain("@apply");
  });

  // A rule that is nothing but variants compiles to `.tr:nth-child(even) { … }` / `@media (hover: hover) { .tr:hover … }`:
  // the condition has to be kept, not only the declarations.
  it("keeps the variants of rules made only of variants", async () => {
    const css = await build(plugin(), [
      "table",
      "table-striped",
      "table-hover",
      "navbar-dark",
      "navbar-btn",
      "text-dark",
    ]);

    expect(hasRule(css, ".table-striped > tbody > tr:nth-child(even)")).toBe(true);
    expect(hasRule(css, ".table-striped > tbody > tr")).toBe(false);
    expect(css).toMatch(/@media \(hover: hover\) \{\s*\.table-hover > tbody > tr:hover \{\s*background-color/);
    expect(css).toMatch(/@media \(hover: hover\) \{\s*html :where\(a\.text-dark\):hover \{\s*color/);
    expect(hasRule(css, ".navbar-dark .navbar-btn:focus")).toBe(true);
    expect(hasRule(css, ".navbar-dark .navbar-btn")).toBe(false);
  });
});

describe("variables", () => {
  const allClasses = componentNames.flatMap(classesOf).filter((name) => !name.startsWith("text-"));

  it("only defines vui variables, besides Tailwind's --tw-*", async () => {
    const css = await build(
      plugin("prefix: v-;"),
      allClasses.map((name) => `v-${name}`),
    );

    // `--color-vui-primary-600`, `--radius-vui-field`, `--vui-prefix`…
    expect(declaredVariables(css).filter((name) => !/^--([a-z]+-)?vui-|^--tw-/.test(name))).toEqual([]);
  });

  it.each([
    ["daisyUI first", `${DAISYUI}\n${plugin("prefix: v-;")}`],
    ["versoly first", `${plugin("prefix: v-;")}\n${DAISYUI}`],
  ])("doesn't change daisyUI's variables and utilities (%s)", async (_, plugins) => {
    const classes = ["btn", "btn-primary", "bg-primary", "rounded-field", "v-btn", "v-btn-primary", "bg-vui-primary"];
    const daisyOnly = await build(DAISYUI, classes);
    const css = await build(plugins, classes);

    for (const name of ["--color-primary", "--color-info", "--radius-field", "--radius-box", "--radius-selector"]) {
      expect(variables(css, name), name).toEqual(variables(daisyOnly, name));
    }
    expect(css).toMatch(/\.bg-primary \{\s*background-color: var\(--color-primary\);/);
    expect(css).toMatch(/\.rounded-field \{\s*border-radius: var\(--radius-field\);/);
    expect(css).toMatch(/\.bg-vui-primary \{\s*background-color: var\(--color-vui-primary\);/);
    expect(css).toMatch(/\.v-btn-primary \{[^}]*background-color: var\(--color-vui-primary-600\)/);
    expect(variable(css, "--color-vui-primary-600")).toMatch(/^oklch\(/);
  });
});

describe("layers", () => {
  const classes = [
    "btn",
    "btn-lg",
    "btn-primary",
    "btn-outline",
    "btn-ghost",
    "dropdown-menu",
    "show",
    "form-input",
    "container",
    "prose",
    "px-8",
  ];

  it.each([
    [".btn", "utilities > versoly.l1.l2.l3"],
    [".btn-lg", "utilities > versoly.l1.l2"],
    [".btn-primary", "utilities > versoly.l1"],
    [".btn-outline.btn-primary", "utilities > versoly.l1"],
    ['.btn-ghost.btn-primary[aria-current="page"]', "utilities > versoly"],
    [".dropdown-menu.show", "utilities > versoly"],
    [".form-input", "utilities > versoly.l1.l2.l3"],
    [".container", "utilities"],
    [".prose a", "utilities"],
    [".px-8", "utilities"],
  ])("puts %s in %s", async (selector, layers) => {
    const css = await build(plugin(), classes);

    expect(layerOf(css, selector)).toBe(layers);
  });

  it("puts the forms classes in the weakest layer", async () => {
    const css = await build(plugin(), ["form-input"]);
    const forms = ruleIndex(css, "@layer versoly.l1.l2.l3.forms");

    expect(forms).toBeGreaterThan(-1);
    expect(css.slice(forms)).toMatch(/^\s*@layer versoly\.l1\.l2\.l3\.forms \{\s*\.form-input \{/);
  });

  it("lets utilities override component styles, whatever the order", async () => {
    const css = await build(plugin(), ["btn", "px-8", "modal", "opacity-100", "container", "max-w-sm"]);

    expect(layerOf(css, ".px-8")).toBe("utilities");
    expect(layerOf(css, ".opacity-100")).toBe("utilities");
    expect(layerOf(css, ".modal")).toBe("utilities > versoly.l1.l2.l3");
    // unlayered `.container` still comes before the utilities
    expect(ruleIndex(css, ".container")).toBeLessThan(ruleIndex(css, ".max-w-sm"));
  });
});

describe("include", () => {
  it("adds only one component", async () => {
    const css = await build(plugin("include: button;"), ["btn", "btn-primary", "card", "alert"]);

    expect(hasRule(css, ".btn")).toBe(true);
    expect(hasRule(css, ".btn-primary")).toBe(true);
    expect(hasRule(css, ".card")).toBe(false);
    expect(hasRule(css, ".alert")).toBe(false);
    expect(hasRule(css, "body")).toBe(false);
    expect(hasRule(css, '[data-toggle="dropdown"]')).toBe(false);
  });

  it("adds a list of components", async () => {
    const css = await build(plugin("include: button, card, dropdown;"), ["btn", "card", "alert", "dropdown-menu"]);

    expect(hasRule(css, ".btn")).toBe(true);
    expect(hasRule(css, ".card")).toBe(true);
    expect(hasRule(css, ".dropdown-menu")).toBe(true);
    expect(hasRule(css, '[data-toggle="dropdown"]')).toBe(true);
    expect(hasRule(css, ".alert")).toBe(false);
  });

  it("keeps the color variables", async () => {
    const css = await build(plugin("include: card;"));

    expect(variable(css, "--color-vui-primary-600")).toMatch(/^oklch\(/);
    expect(variable(css, "--color-vui-dark")).toMatch(/^oklch\(/);
  });

  it("adds the forms classes only with the form component", async () => {
    const withForm = await build(plugin("include: form;"), ["form-input"]);
    const withoutForm = await build(plugin("include: button;"), ["form-input"]);

    expect(withForm).toMatch(/\.form-input \{[^}]*appearance: none/);
    expect(withoutForm).not.toMatch(/\.form-input/);
  });
});

describe("exclude", () => {
  it("skips components", async () => {
    const css = await build(plugin("exclude: base, button;"), ["btn", "card", "h1"]);

    expect(hasRule(css, ".btn")).toBe(false);
    expect(hasRule(css, ".card")).toBe(true);
    expect(hasRule(css, "body")).toBe(false);
    expect(hasRule(css, ".h1")).toBe(false);
    expect(hasRule(css, "html :where(a)")).toBe(true);
  });

  it("is applied after include", async () => {
    const css = await build(plugin("include: button, card; exclude: card;"), ["btn", "card"]);

    expect(hasRule(css, ".btn")).toBe(true);
    expect(hasRule(css, ".card")).toBe(false);
  });

  it("keeps the color variables when everything is excluded", async () => {
    const css = await build(plugin(`exclude: ${componentNames.join(", ")};`), ["btn"]);

    expect(hasRule(css, ".btn")).toBe(false);
    expect(variable(css, "--color-vui-primary-600")).toMatch(/^oklch\(/);
  });

  it("warns about unknown components", async () => {
    await build(plugin("include: buton; exclude: cards;"));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown component "buton" in "include"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown component "cards" in "exclude"'));
  });
});

describe("prefix", () => {
  it.each(['"v-"', "v-"])("prefixes component classes with %s", async (prefix) => {
    const css = await build(plugin(`prefix: ${prefix};`), [
      "btn",
      "v-btn",
      "v-btn-group",
      "v-btn-primary",
      "v-navbar-row",
      "text-info",
      "prose",
      "v-form-input",
    ]);

    expect(hasRule(css, ".v-btn")).toBe(true);
    expect(hasRule(css, ".v-btn-primary")).toBe(true);
    expect(hasRule(css, ".v-btn-group .v-btn")).toBe(true);
    expect(hasRule(css, ".btn")).toBe(false);
    expect(variable(css, "--vui-prefix")).toBe('"v-"');
    // not prefixed: state classes, Tailwind utilities, other libraries, attribute selectors
    expect(hasRule(css, ".v-navbar-row.show")).toBe(true);
    expect(hasRule(css, "html :where(a.text-info)")).toBe(true);
    expect(hasRule(css, ".prose a")).toBe(true);
    expect(hasRule(css, '[data-toggle="dropdown"]')).toBe(true);
    // the forms classes the form component is built on
    expect(css).toMatch(/\.v-form-input \{[^}]*appearance: none/);
  });

  it("doesn't add the prefix variable without a prefix", async () => {
    const css = await build(plugin());

    expect(variable(css, "--vui-prefix")).toBeUndefined();
  });

  it("ignores an invalid prefix", async () => {
    const css = await build(plugin("prefix: 1x;"), ["btn", "1xbtn"]);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid prefix "1x"'));
    expect(hasRule(css, ".btn")).toBe(true);
  });
});

describe("Tailwind prefix", () => {
  it("prefixes the classes like Tailwind utilities: tw:btn", async () => {
    const css = await build(plugin(), ["tw:btn", "tw:btn-primary", "tw:btn-group", "btn", "tw:px-8"], TW);

    expect(hasRule(css, ".tw\\:btn")).toBe(true);
    expect(hasRule(css, ".tw\\:btn-primary")).toBe(true);
    expect(hasRule(css, ".tw\\:btn-group .tw\\:btn")).toBe(true);
    expect(hasRule(css, ".btn")).toBe(false);
    expect(layerOf(css, ".tw\\:btn")).toBe("utilities > versoly.l1.l2.l3");
    expect(layerOf(css, ".tw\\:px-8")).toBe("utilities");
  });

  it("combines with the plugin prefix: tw:v-btn", async () => {
    const css = await build(plugin("prefix: v-;"), ["tw:v-btn", "tw:v-form-input", "tw:btn", "v-btn"], TW);

    expect(hasRule(css, ".tw\\:v-btn")).toBe(true);
    expect(hasRule(css, ".tw\\:btn")).toBe(false);
    expect(hasRule(css, ".v-btn")).toBe(false);
    expect(css).toMatch(/\.tw\\:v-form-input \{[^}]*appearance: none/);
  });

  it("works with every component", async () => {
    const classes = componentNames.flatMap(classesOf).map((name) => `tw:${name}`);
    const css = await build(plugin(), classes, TW);

    expect(css).toMatch(/\.tw\\:card \{/);
    expect(css).not.toContain("@apply");
  });

  it("passes colors set in @theme to the components", async () => {
    const css = await build(`${plugin()}\n@theme { --color-vui-primary-600: red; }`, ["tw:btn-primary"], TW);

    expect(variable(css, "--color-vui-primary-600")).toBe("red");
    expect(css).toMatch(/\.tw\\:btn-primary \{[^}]*background-color: var\(--color-vui-primary-600\)/);
  });
});

describe("design tokens", () => {
  it("defaults the radius tokens to Tailwind's radius scale", async () => {
    const css = await build(plugin());

    expect(variable(css, "--radius-vui-selector")).toBe("0.25rem");
    expect(variable(css, "--radius-vui-field")).toBe("0.375rem");
    expect(variable(css, "--radius-vui-box")).toBe("0.5rem");
  });

  it("follows the user's Tailwind theme", async () => {
    const css = await build(`${plugin()}\n@theme { --radius-lg: 1rem; --color-gray-100: #eee; }`);

    expect(variable(css, "--radius-vui-box")).toBe("1rem");
    expect(variable(css, "--color-vui-gray-100")).toBe("#eee");
  });

  it("lets @theme set the tokens", async () => {
    const css = await build(`${plugin()}\n@theme { --radius-vui-field: 0; }`, ["btn"]);

    expect(variable(css, "--radius-vui-field")).toBe("0");
    expect(css).toMatch(/\.btn \{[^}]*border-radius: var\(--radius-vui-field\)/);
  });

  it("follows the user's theme with prefix(tw)", async () => {
    const css = await build(
      `${plugin()}\n@theme { --radius-md: 2px; --color-gray-100: #eee; }`,
      ["tw:btn", "tw:alert"],
      TW,
    );

    expect(variable(css, "--radius-vui-field")).toBe("2px");
    expect(variable(css, "--color-vui-gray-100")).toBe("#eee");
    expect(css).toMatch(/\.tw\\:alert \{[^}]*background-color: var\(--color-vui-gray-100\)/);
  });

  it("only sets the Tailwind colors the included components use", async () => {
    const css = await build(plugin("include: badge;"));

    expect(variable(css, "--color-vui-white")).toBeDefined();
    expect(variable(css, "--color-vui-purple-600")).toBeUndefined();
  });
});

describe("theme", () => {
  it("lets @theme override colors", async () => {
    const css = await build(`${plugin()}\n@theme { --color-vui-primary-600: red; --color-vui-dark: #000; }`);

    expect(variable(css, "--color-vui-primary-600")).toBe("red");
    expect(variable(css, "--color-vui-dark")).toBe("#000");
    // shades that aren't overridden keep their defaults
    expect(variable(css, "--color-vui-primary-500")).toMatch(/^oklch\(/);
  });

  it("lets plain CSS override the variables", async () => {
    const css = await build(`${plugin()}\n:root { --color-vui-primary-600: red; }`);

    // unlayered, so it beats the plugin's variables in the base layer
    expect(layerOf(css, ":root")).toBe("");
    expect(variables(css, "--color-vui-primary-600")).toContain("red");
  });

  it("makes the colors available in custom CSS", async () => {
    const css = await build(`${plugin("include: button;")}\n.hero { color: var(--color-vui-primary-600); }`);

    expect(css).toMatch(/\.hero \{\s*color: var\(--color-vui-primary-600\);/);
    expect(variable(css, "--color-vui-primary-600")).toMatch(/^oklch\(/);
  });
});

describe("JavaScript config", () => {
  it("accepts options from @config", async () => {
    const css = await build('@config "./test/fixtures/tailwind.config.mjs";', ["js-btn", "js-card", "btn"]);

    expect(hasRule(css, ".js-btn")).toBe(true);
    expect(hasRule(css, ".js-card")).toBe(false);
    expect(hasRule(css, ".btn")).toBe(false);
    expect(variable(css, "--vui-prefix")).toBe('"js-"');
  });
});
