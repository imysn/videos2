// Technical literals are permitted by their AST context, never by component/file allowlists.
const contentAttributes = new Set([
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "alt",
  "title",
  "placeholder",
  "label",
]);
const technicalNames = new Set([
  "Español",
  "Polski",
  "English",
  "Rave privado",
  "Google Drive",
  "HLS",
  "DASH",
  "SRT",
  "VTT",
  "PiP",
]);
const legacyDeviceLabels = new Set(["Recuperación", "Navegador"]);
const internalErrors = new Set([
  "Auth provider required",
  "I18n provider required",
]);
const technicalAttributes = (name) => !contentAttributes.has(name);
function technicalText(value) {
  return (
    !/[\p{L}]/u.test(value) ||
    technicalNames.has(value) ||
    /^(https?:\/\/|\/|#[\w-]+|[\w.+-]+\/[^ ]+$)/.test(value) ||
    /^[A-Z][A-Z0-9_]+$/.test(value)
  );
}
function translationArgument(node) {
  let child = node;
  for (let call = node.parent; call; child = call, call = call.parent) {
    if (call.type === "CallExpression")
      return (
        ["t", "label"].includes(call.callee.name) && call.arguments[0] === child
      );
    if (
      [
        "JSXExpressionContainer",
        "ArrowFunctionExpression",
        "FunctionDeclaration",
      ].includes(call.type)
    )
      return false;
  }
  return false;
}
function rendered(node) {
  let parent = node.parent;
  while (
    parent &&
    ![
      "CallExpression",
      "ArrowFunctionExpression",
      "FunctionDeclaration",
      "VariableDeclarator",
    ].includes(parent.type)
  ) {
    if (parent.type === "JSXAttribute")
      return contentAttributes.has(parent.name.name);
    if (parent.type === "JSXExpressionContainer") {
      return (
        parent.parent.type !== "JSXAttribute" ||
        contentAttributes.has(parent.parent.name.name)
      );
    }
    parent = parent.parent;
  }
  return false;
}
function allowedContext(node, value) {
  const parent = node.parent;
  if (
    [
      "ImportDeclaration",
      "ExportNamedDeclaration",
      "ExportAllDeclaration",
      "ImportExpression",
      "TSLiteralType",
    ].includes(parent?.type)
  )
    return true;
  if (parent?.type === "Property" && parent.key === node) return true;
  if (
    parent?.type === "Property" &&
    ["hour", "minute", "dateStyle", "timeStyle", "style"].includes(
      parent.key.name,
    )
  )
    return true;
  if (
    parent?.type === "BinaryExpression" &&
    ["===", "!==", "==", "!=", "in"].includes(parent.operator)
  )
    return true;
  if (parent?.type === "MemberExpression" && parent.property === node)
    return true;
  if (parent?.type === "JSXAttribute" && technicalAttributes(parent.name.name))
    return true;
  if (translationArgument(node)) return true;
  if (
    parent?.type === "CallExpression" &&
    parent.callee.object?.name === "console"
  )
    return true;
  for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
    if (
      ["ArrowFunctionExpression", "FunctionDeclaration"].includes(ancestor.type)
    )
      break;
    if (
      ancestor.type === "JSXAttribute" &&
      ["style", "className"].includes(ancestor.name.name)
    )
      return true;
  }
  if (
    parent?.type === "CallExpression" &&
    [
      "classes",
      "querySelector",
      "closest",
      "querySelectorAll",
      "match",
      "replace",
      "split",
      "join",
    ].includes(parent.callee.name ?? parent.callee.property?.name)
  )
    return true;
  if (
    parent?.type === "NewExpression" &&
    parent.callee.name === "Error" &&
    internalErrors.has(value)
  )
    return true;
  // Older database rows contain these two human device labels. Only equality checks may use them.
  if (
    parent?.type === "BinaryExpression" &&
    ["===", "!=="].includes(parent.operator) &&
    legacyDeviceLabels.has(value)
  )
    return true;
  return false;
}
export const noUiLiterals = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      hardcoded:
        "Visible text must use i18n: {{value}} (ES, PL and EN are required).",
    },
  },
  create(context) {
    const report = (node, value) =>
      context.report({
        node,
        messageId: "hardcoded",
        data: { value: value.slice(0, 80) },
      });
    return {
      JSXText(node) {
        const value = node.value.trim();
        if (value && !technicalText(value)) report(node, value);
      },
      Literal(node) {
        if (typeof node.value !== "string") return;
        const value = node.value;
        if (allowedContext(node, value) || technicalText(value)) return;
        // Message state must contain a typed translation key, even for a single lowercase word.
        if (
          node.parent?.type === "CallExpression" &&
          ["setSaved", "setNotice"].includes(node.parent.callee.name) &&
          !/^[a-z]+\.[a-zA-Z0-9_.-]+$/.test(value)
        ) {
          report(node, value);
          return;
        }
        // Slugs, enum values, API headers and keys are code. In rendered content they are still UI.
        if (
          !rendered(node) &&
          (/^[a-z][a-zA-Z0-9_.:-]*$/.test(value) ||
            /^[A-Z][a-z]+(?:-[A-Z][a-z]+)+$/.test(value) ||
            /^\[.*\]$/.test(value))
        )
          return;
        report(node, value);
      },
      TemplateLiteral(node) {
        const value = node.quasis
          .map((part) => part.value.cooked ?? "")
          .join("");
        if (allowedContext(node, value) || technicalText(value)) return;
        // CSS sizes, track IDs and routes remain technical. Human words in templates are prohibited.
        if (
          /^[\s\d.,:%×+−()|p-]*$/.test(value) ||
          (!rendered(node) && /^[a-z][a-zA-Z0-9_.:/-]*$/.test(value))
        )
          return;
        report(node, value);
      },
    };
  },
};
