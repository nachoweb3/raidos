import { DISABLED_CHAIN_IDS } from "../chains/config.js";

export const validChain = (chain: string) => {
  if (DISABLED_CHAIN_IDS.includes(chain)) throw new Error("invalid chain: network disabled");
  if (!/^[a-z0-9_-]{1,40}$/.test(chain)) throw new Error("invalid chain");
  return chain;
};
export const validAddress = (address: string) => {
  if (!/^[A-Za-z0-9:_-]{20,160}$/.test(address)) throw new Error("invalid token or pool address");
  return address;
};
