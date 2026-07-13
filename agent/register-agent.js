// Register the Restwise keeper agent in the ERC-8004 Identity Registry on Celo.
//
// Usage: fill agent-metadata.json placeholders, PIN IT TO IPFS (the validator flags
// https:// URIs as mutable — the CID is the integrity check), then:
//   AGENT_METADATA_URI=ipfs://<CID> npm run register
//
// agent-metadata.json follows the current EIP-8004 registration-v1 shape:
// `type` = the spec URI (not "Agent"), `services` array with `endpoint` keys
// (not `endpoints`/`url`) — older shapes trigger 8004scan validation warnings.
import { ethers } from "ethers";
import { config, requireConfig } from "./config.js";

// ERC-8004 Identity Registry (ERC-721 based)
const IDENTITY_REGISTRY =
  process.env.IDENTITY_REGISTRY ??
  (config.chainId === 42220
    ? "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" // Celo mainnet
    : "0x8004A818BFB912233c491871b3d84c89A494BD9e"); // Celo Sepolia

const REGISTRY_ABI = [
  "function register(string agentURI) returns (uint256)",
  "function setMetadata(uint256 agentId, string key, bytes value)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

requireConfig("keeperPrivateKey");
const metadataURI = process.env.AGENT_METADATA_URI;
if (!metadataURI) throw new Error("Set AGENT_METADATA_URI to the hosted agent-metadata.json");

const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
const keeper = new ethers.Wallet(config.keeperPrivateKey, provider);
const registry = new ethers.Contract(IDENTITY_REGISTRY, REGISTRY_ABI, keeper);

const tx = await registry.register(metadataURI);
const receipt = await tx.wait();
const transfer = receipt.logs
  .map((log) => { try { return registry.interface.parseLog(log); } catch { return null; } })
  .find((parsed) => parsed?.name === "Transfer");
const agentId = transfer.args.tokenId;
console.log(`Registered agent #${agentId} in ERC-8004 Identity Registry ${IDENTITY_REGISTRY}`);

await (await registry.setMetadata(agentId, "category", ethers.toUtf8Bytes("defi-yield-optimizer"))).wait();
await (await registry.setMetadata(agentId, "vault", ethers.toUtf8Bytes(config.vaultAddress ?? ""))).wait();
console.log("Metadata set: category=defi-yield-optimizer, vault address recorded");
