import { Pill } from "../Pill";

const variants = ["success", "warning", "error", "info", "neutral"] as const;

export function PillDemo() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {variants.map((v) => (
          <Pill key={v} variant={v} size="md">
            {v}
          </Pill>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {variants.map((v) => (
          <Pill key={v} variant={v} size="sm">
            {v} sm
          </Pill>
        ))}
      </div>
    </div>
  );
}
