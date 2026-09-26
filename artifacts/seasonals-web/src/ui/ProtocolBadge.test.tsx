import { render } from "@testing-library/react";
import { ProtocolBadge, brandStyle, protocolBrandKey, protocolLogo } from "./ProtocolBadge";

test.each(["pendle", "lido", "ethena", "uniswap", "cca", "aqua"])("%s has a logo image", (id) => {
  expect(protocolLogo(id)).toBeTruthy();
  const { container } = render(<ProtocolBadge id={id} name={id} size={22} />);
  expect(container.querySelector("img.protocol-badge")).not.toBeNull();
});

test("protocol without a supplied logo falls back to a monogram", () => {
  const { container } = render(<ProtocolBadge id="aave" name="Aave" size={22} />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".monogram")?.textContent).toBe("A");
});

test("CCA uses Uniswap's brand color and Aqua uses 1inch's", () => {
  expect(protocolBrandKey("cca")).toBe("uniswap");
  expect(protocolBrandKey("aqua")).toBe("oneinch");
  expect(brandStyle("cca")).toEqual({ "--accent": "var(--brand-uniswap)", "--accent-bg": "var(--brandbg-uniswap)" });
});

test("protocols without a brand color stay neutral", () => {
  expect(protocolBrandKey("kamino")).toBeNull();
  expect(brandStyle("kamino")).toEqual({});
  expect(brandStyle(null)).toEqual({});
});
