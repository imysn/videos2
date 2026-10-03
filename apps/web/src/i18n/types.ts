import type { es } from "./es";
export type { Locale } from "../../../../packages/contracts/src/locale";
export type Key = keyof typeof es;
export type Catalog = {
  [K in Key]: (typeof es)[K] extends string
    ? string
    : { [C in keyof (typeof es)[K]]: string };
};
type Placeholders<S extends string> =
  S extends `${string}{${infer P}}${infer Rest}`
    ? P | Placeholders<Rest>
    : never;
type Message<K extends Key> = (typeof es)[K];
type Text<K extends Key> =
  Message<K> extends string
    ? Message<K>
    : Message<K>[keyof Message<K>] & string;
type Params<K extends Key> = Placeholders<Text<K>>;
export type Translator = <K extends Key>(
  key: K,
  ...args: [Params<K>] extends [never]
    ? []
    : [
        values: {
          [P in Params<K>]: P extends "count" ? number : string | number;
        },
      ]
) => string;
