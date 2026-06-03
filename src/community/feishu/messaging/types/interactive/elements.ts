import type { Color, TextAlign, TextSize } from "./styles";

export interface BaseElement<T extends string = string> {
  tag: T;
  element_id?: string;
}

export interface BaseContainer<
  T extends string = string,
> extends BaseElement<T> {
  elements: Element[];
}

export interface PlainTextElement extends BaseElement<"plain_text"> {
  content: string;
  text_size?: TextSize;
  text_color?: Color;
  text_align?: TextAlign;
  lines?: number;
}

export interface StandardIconElement extends BaseElement<"standard_icon"> {
  token: string;
  color?: Color;
  size?: string;
}

export interface CustomIconElement extends BaseElement<"custom_icon"> {
  img_key: string;
  size?: string;
}

export type IconElement = StandardIconElement | CustomIconElement;

export interface DivElement extends BaseElement<"div"> {
  tag: "div";
  icon?: IconElement;
  text?: PlainTextElement;
  margin?: string;
  width?: string;
}

export interface MarkdownElement extends BaseElement<"markdown"> {
  tag: "markdown";
  icon?: IconElement;
  margin?: string;
  text_size?: TextSize;
  text_align?: TextAlign;
  content: string;
}

export interface CollapsiblePanel extends BaseContainer<"collapsible_panel"> {
  direction?: "vertical" | "horizontal";
  vertical_spacing?: string;
  horizontal_spacing?: string;
  vertical_align?: "top" | "center" | "bottom";
  horizontal_align?: "left" | "center" | "right";
  padding?: string;
  margin?: string;
  expanded?: boolean;
  background_color?: Color;
  border?: {
    color?: Color;
    corner_radius?: string;
  };
  header: {
    title: PlainTextElement | MarkdownElement;
    background_color?: Color;
    vertical_align?: "top" | "center" | "bottom";
    padding?: string;
    position?: "top" | "bottom";
    width?: string;
    icon?: IconElement;
    icon_position?: "left" | "right" | "follow_text";
    icon_expanded_angle?: number;
  };
}

export interface ButtonElement extends BaseElement<"button"> {
  tag: "button";
  text: PlainTextElement;
  type?: "default" | "primary" | "danger";
  value?: Record<string, string>;
  confirm?: {
    title: PlainTextElement;
    text: PlainTextElement;
  };
}

export interface ActionElement extends BaseElement<"action"> {
  tag: "action";
  actions: ButtonElement[];
  layout?: "bisected" | "trisection" | "flow";
}

export type Element =
  | ActionElement
  | CollapsiblePanel
  | DivElement
  | IconElement
  | MarkdownElement
  | PlainTextElement;
