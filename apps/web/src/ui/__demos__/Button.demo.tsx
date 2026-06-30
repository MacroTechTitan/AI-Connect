import { Button } from "../Button";

const variants = ["primary", "secondary", "ghost", "danger"] as const;
const sizes = ["sm", "md", "lg"] as const;

export function ButtonDemo() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {variants.map((v) => (
        <div
          key={v}
          style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
        >
          {sizes.map((s) => (
            <Button key={s} variant={v} size={s}>
              {v} {s}
            </Button>
          ))}
        </div>
      ))}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <Button loading>Loading</Button>
        <Button disabled>Disabled</Button>
        <Button variant="secondary" startIcon={<span aria-hidden="true">★</span>}>
          With icon
        </Button>
      </div>
      <div style={{ maxWidth: 320 }}>
        <Button fullWidth>Full width</Button>
      </div>
    </div>
  );
}
