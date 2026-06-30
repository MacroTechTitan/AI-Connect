import { ToastProvider } from "../Toast";
import { BadgeDemo } from "./Badge.demo";
import { ButtonDemo } from "./Button.demo";
import { CardDemo } from "./Card.demo";
import { InputDemo } from "./Input.demo";
import { ModalDemo } from "./Modal.demo";
import { PillDemo } from "./Pill.demo";
import { ToastDemo } from "./Toast.demo";
import { WizardDemo } from "./Wizard.demo";

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: "24px 0",
  borderTop: "1px solid rgba(128,128,128,0.25)",
};

/**
 * Live demo of every design-system primitive on one page. Rendered when the
 * app boots at /ui or with ?ui=demo (see main.tsx). Wrapped in ToastProvider
 * so the Toast demo's useToast() resolves. Use this page to eyeball changes to
 * the design system before they reach real flows.
 */
export function UiDemoPage() {
  return (
    <ToastProvider>
      <div
        style={{
          padding: 32,
          maxWidth: 1200,
          margin: "0 auto",
          fontFamily: "var(--ai-font-sans)",
        }}
      >
        <h1>AI Connect Design System</h1>
        <p>
          Live demo of all primitive components. Use this page to visually
          verify changes to the design system.
        </p>

        <section style={sectionStyle}>
          <h2>Button</h2>
          <ButtonDemo />
        </section>
        <section style={sectionStyle}>
          <h2>Input</h2>
          <InputDemo />
        </section>
        <section style={sectionStyle}>
          <h2>Modal</h2>
          <ModalDemo />
        </section>
        <section style={sectionStyle}>
          <h2>Card</h2>
          <CardDemo />
        </section>
        <section style={sectionStyle}>
          <h2>Badge</h2>
          <BadgeDemo />
        </section>
        <section style={sectionStyle}>
          <h2>Pill</h2>
          <PillDemo />
        </section>
        <section style={sectionStyle}>
          <h2>Wizard</h2>
          <WizardDemo />
        </section>
        <section style={sectionStyle}>
          <h2>Toast</h2>
          <ToastDemo />
        </section>
      </div>
    </ToastProvider>
  );
}
