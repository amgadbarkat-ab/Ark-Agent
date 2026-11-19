import { App } from "./App";
import { BrandBar } from "./BrandBar";
import { LanguageSwitch } from "./LanguageSwitch";

/**
 * The setup window: the company's side, EN / ΕΛ, and the steps. The same for every customer: a
 * trial profile is loaded by BlackArk staff from the import folder in the setup session (v0.1.50,
 * docs/trials/README.md), never from a button here.
 */
export function SetupWindow() {
  return (
    <>
      <BrandBar />
      <LanguageSwitch />
      <App />
    </>
  );
}
