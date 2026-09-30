import styles from "./layout.module.css";
export function classes(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => styles[name] ?? name)
    .join(" ");
}
