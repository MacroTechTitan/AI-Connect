import { useState } from "react";

import { Input } from "../Input";

export function InputDemo() {
  const [value, setValue] = useState("");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 360 }}>
      <Input
        placeholder="Default, no label"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Input label="With label" type="email" placeholder="you@example.com" />
      <Input
        label="With helper"
        helperText="We'll never share this."
        placeholder="Helper below"
      />
      <Input
        label="With error"
        errorText="This field is required."
        placeholder="Error state"
      />
      <Input
        label="With prefix / suffix"
        prefix={<span>$</span>}
        suffix={<span>.00</span>}
        placeholder="0"
      />
      <Input label="Disabled" disabled placeholder="Can't touch this" />
    </div>
  );
}
