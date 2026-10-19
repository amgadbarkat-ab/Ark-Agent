// URLs rather than imports: the bundler copies each file and names it here, and a test (which has no
// bundler) gets a plain address instead of trying to read a picture as code.
const scene = new URL("./assets/arkagent-scene.jpg", import.meta.url).href;

/** A few of the roles a digital employee comes in, to say it comes in one. Cut from the Ark Team roster. */
const ROLES = [
  {
    name: "Sales",
    face: new URL("./assets/roles/sales.jpg", import.meta.url).href,
  },
  {
    name: "Accounting",
    face: new URL("./assets/roles/accounting.jpg", import.meta.url).href,
  },
  {
    name: "Finance",
    face: new URL("./assets/roles/finance.jpg", import.meta.url).href,
  },
  {
    name: "Front desk",
    face: new URL("./assets/roles/front-desk.jpg", import.meta.url).href,
  },
];

/**
 * Small embers rising behind the figure. Positions and timings are fixed here rather than drawn at
 * random, so the screen is the same every time it opens and a test can see it.
 */
const EMBERS = Array.from({ length: 16 }, (_, index) => ({
  left: `${(index * 37 + 11) % 100}%`,
  size: `${2 + ((index * 5) % 4)}px`,
  delay: `${-((index * 1.7) % 14)}s`,
  duration: `${10 + ((index * 3) % 9)}s`,
}));

/**
 * What ArkAgent is, before it asks for anything.
 *
 * The first thing somebody sees after a download, so it is composed as a scene rather than a form: the
 * company's character in its own colours, what a digital employee is in two sentences, and where the
 * button is. Few words on purpose. The person here was sent a link by their IT department and has not
 * decided to care yet: they need to know what this is, that it will not ask them for anything
 * technical, and where to press. Everything else waits for a screen that needs it.
 */
export function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-sky" aria-hidden="true">
        <span className="glow glow-a" />
        <span className="glow glow-b" />
        {EMBERS.map((ember) => (
          <i
            key={ember.left}
            className="ember"
            style={{
              left: ember.left,
              width: ember.size,
              height: ember.size,
              animationDelay: ember.delay,
              animationDuration: ember.duration,
            }}
          />
        ))}
      </div>
      <img className="welcome-figure" src={scene} alt="" aria-hidden="true" />
      <div className="welcome-copy">
        <p className="eyebrow">BlackArk · ArkAgent</p>
        <h1>
          Your own AI <em>digital employees</em>, on this computer.
        </h1>
        <p className="lede big">
          Give a digital employee a role and it knows what that job needs. It
          plans the work, takes the actions and carries them through, while you
          keep the final say.
        </p>
        <ul className="role-strip" aria-label="Some of the roles">
          {ROLES.map((role) => (
            <li key={role.name}>
              <img src={role.face} alt="" aria-hidden="true" />
              <span>{role.name}</span>
            </li>
          ))}
          <li className="more">and more</li>
        </ul>
        <div className="row">
          <button type="button" className="cta" onClick={onStart}>
            Set up ArkAgent
          </button>
        </div>
        <p className="footnote">
          Takes a few minutes. ArkAgent installs what it needs first, then asks
          how you want to connect an AI model.
        </p>
      </div>
    </div>
  );
}
