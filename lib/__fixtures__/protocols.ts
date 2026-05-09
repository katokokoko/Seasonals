import type { Protocol } from "../types/position";
import { PositionCategory, TrustLevel } from "../types/enums";

export const fixtureProtocolKamino: Protocol = {
  protocol_id: "kamino",
  name: "Kamino",
  category: PositionCategory.Lending,
  trust_level: TrustLevel.S,
  enabled: true,
  metadata: {
    homepage: "https://kamino.finance",
    docs_url: "https://docs.kamino.finance",
  },
};

export const fixtureProtocolJito: Protocol = {
  protocol_id: "jito",
  name: "Jito",
  category: PositionCategory.Staking,
  trust_level: TrustLevel.S,
  enabled: true,
  metadata: {
    homepage: "https://jito.network",
    docs_url: "https://docs.jito.network",
  },
};

export const fixtureProtocolStreamflow: Protocol = {
  protocol_id: "streamflow",
  name: "Streamflow",
  category: PositionCategory.Vesting,
  trust_level: TrustLevel.S,
  enabled: true,
  metadata: {
    homepage: "https://streamflow.finance",
  },
};

export const fixtureProtocolMarinade: Protocol = {
  protocol_id: "marinade",
  name: "Marinade",
  category: PositionCategory.Staking,
  trust_level: TrustLevel.A,
  enabled: true,
  metadata: {
    homepage: "https://marinade.finance",
  },
};

export const fixtureProtocolKaminoRestake: Protocol = {
  protocol_id: "kamino_restake",
  name: "Kamino Restake",
  category: PositionCategory.Restaking,
  trust_level: TrustLevel.A,
  enabled: true,
  metadata: { homepage: "https://kamino.finance" },
};

export const fixtureProtocolKaminoVault: Protocol = {
  protocol_id: "kamino_vault",
  name: "Kamino Vault",
  category: PositionCategory.Vault,
  trust_level: TrustLevel.S,
  enabled: true,
  metadata: { homepage: "https://kamino.finance" },
};

export const fixtureProtocolMeteora: Protocol = {
  protocol_id: "meteora",
  name: "Meteora",
  category: PositionCategory.LP,
  trust_level: TrustLevel.A,
  enabled: true,
  metadata: { homepage: "https://meteora.ag" },
};

export const fixtureProtocolRateX: Protocol = {
  protocol_id: "ratex",
  name: "RateX",
  category: PositionCategory.PTYT,
  trust_level: TrustLevel.B,
  enabled: true,
  metadata: { homepage: "https://rate-x.io" },
};

export const fixtureProtocolJupiterLend: Protocol = {
  protocol_id: "jupiter_lend",
  name: "Jupiter Lend",
  category: PositionCategory.Stable,
  trust_level: TrustLevel.S,
  enabled: true,
  metadata: { homepage: "https://jup.ag" },
};

export const fixtureProtocols: Protocol[] = [
  fixtureProtocolKamino,
  fixtureProtocolJito,
  fixtureProtocolStreamflow,
  fixtureProtocolMarinade,
  fixtureProtocolKaminoRestake,
  fixtureProtocolKaminoVault,
  fixtureProtocolMeteora,
  fixtureProtocolRateX,
  fixtureProtocolJupiterLend,
];
