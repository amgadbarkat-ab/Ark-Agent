import { type Language, switchLanguage, useLanguage } from "./i18n";

const CHOICES: { code: Language; label: string; name: string }[] = [
  { code: "en", label: "EN", name: "English" },
  { code: "el", label: "ΕΛ", name: "Ελληνικά" },
];

/**
 * EN / ΕΛ, on every step of the setup window and first on the first one (#108). Each choice is
 * named in its own language, so whoever cannot read the other one still finds theirs. The app
 * opens in the language chosen here and keeps it; it is changed there in Settings > General.
 */
export function LanguageSwitch() {
  const language = useLanguage();
  return (
    <fieldset className="language-switch">
      <legend className="sr-only">Language · Γλώσσα</legend>
      {CHOICES.map((choice) => (
        <button
          key={choice.code}
          type="button"
          className="quiet"
          lang={choice.code}
          aria-label={choice.name}
          aria-pressed={language === choice.code}
          onClick={() => switchLanguage(choice.code)}
        >
          {choice.label}
        </button>
      ))}
    </fieldset>
  );
}
