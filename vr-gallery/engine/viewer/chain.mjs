// The chain, for a gallery: where broadcast iterations come from, and where caught moments are
// minted. Talks to the Moments contract (contracts/src/Moments.sol) with plain JSON-RPC over
// fetch — no web3 library. The selectors below are `cast sig` outputs; the tests in
// contracts/ pin the contract side, and a browser run against anvil pins this side.
//
//   chain: { rpc, contract, chainId, explorer? }        in gallery.yaml
//
// Reads go to `rpc`. Writes (mint) go through the visitor's wallet (window.ethereum, EIP-1193);
// on a local dev chain with no wallet installed, anvil's unlocked account is used instead.

const SEL = {
  currentEpoch: "0x0593aae7", // currentEpoch(uint256)
  iteration: "0x7ae56eb3", // iteration(uint256,uint64)
  pieces: "0x8f64be30", // pieces(uint256)
  mint: "0x14f6a33a", // mint(uint256,uint64,uint32)
  momentURL: "0x1f8c76b2", // momentURL(uint256)
};
const ERRORS = {
  "0x6f312cbd": "That iteration hasn't started yet.",
  "0x203d82d8": "Too late: this iteration is past its mint window (8191 blocks, about 4.5 hours on Base). Catch a live one.",
  "0xddefae28": "Someone already minted this exact moment.",
  "0x743f4579": "This iteration has given all the moments it can.",
  "0xf7760f25": "Wrong price.",
  "0xc7e95bf9": "That step is past the end of the piece.",
  "0x3aa301f8": "This piece isn't minting right now.",
  "0x1ef1f1a1": "The contract doesn't know this piece.",
};
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// Networks a wallet may not know yet, for wallet_addEthereumChain.
const NETWORKS = {
  84532: { chainName: "Base Sepolia", rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: ["https://sepolia.basescan.org"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
  8453: { chainName: "Base", rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
};

const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const words = (hex) => hex.slice(2).match(/.{64}/g) || [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLocal = (url) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url);

function reason(err) {
  const data = err?.data?.data ?? err?.data ?? err?.error?.data ?? "";
  const sel = typeof data === "string" ? data.slice(0, 10) : "";
  if (ERRORS[sel]) return ERRORS[sel];
  if (err?.code === 4001) return "Cancelled in the wallet.";
  return err?.message || String(err);
}

export function chain(cfg) {
  let id = 0;
  const rpc = async (method, params = []) => {
    const res = await fetch(cfg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const body = await res.json();
    if (body.error) throw body.error;
    return body.result;
  };
  const call = (data) => rpc("eth_call", [{ to: cfg.contract, data }, "latest"]);

  // The wallet to mint with: the visitor's, or anvil's first account on a local chain.
  async function wallet() {
    const eth = globalThis.ethereum;
    if (eth) {
      const [from] = await eth.request({ method: "eth_requestAccounts" });
      if (cfg.chainId && Number(await eth.request({ method: "eth_chainId" })) !== Number(cfg.chainId)) {
        const chainId = "0x" + Number(cfg.chainId).toString(16);
        try {
          await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
        } catch (e) {
          if (e.code !== 4902 || !NETWORKS[cfg.chainId]) throw e; // 4902: the wallet doesn't know this chain
          await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId, ...NETWORKS[cfg.chainId] }] });
        }
      }
      return { from, send: (tx) => eth.request({ method: "eth_sendTransaction", params: [tx] }) };
    }
    if (isLocal(cfg.rpc)) {
      const [from] = await rpc("eth_accounts");
      return { from, send: (tx) => rpc("eth_sendTransaction", [tx]), dev: true };
    }
    throw new Error("No wallet found. Open this page in a browser with a wallet, or on your phone.");
  }

  return {
    cfg,
    async currentEpoch(piece) { return BigInt(await call(SEL.currentEpoch + word(piece))); },
    async iteration(piece, epoch) { return call(SEL.iteration + word(piece) + word(epoch)); },
    // The static fields of pieces(id): epochBlocks, steps, maxPerIteration, price, active.
    async piece(pieceId) {
      const w = words(await call(SEL.pieces + word(pieceId)));
      return { epochBlocks: BigInt("0x" + w[2]), steps: Number("0x" + w[3]), maxPerIteration: Number("0x" + w[4]), price: BigInt("0x" + w[5]), active: w[6].endsWith("1") };
    },
    // An iteration source for a live runner: the current epoch's hash, waiting for a new epoch
    // if the last one has already been shown.
    source(pieceId) {
      let last = -1n;
      return {
        async next() {
          for (;;) {
            try {
              const epoch = await this.epoch();
              if (epoch !== last) { last = epoch; return { hash: await this.hash(epoch), epoch }; }
            } catch (e) { console.warn("[vr-gallery] chain:", reason(e)); }
            await sleep(1500);
          }
        },
        epoch: () => this.currentEpoch(pieceId),
        hash: (epoch) => this.iteration(pieceId, epoch),
      };
    },
    // Mint a caught moment. onStatus gets human-readable progress; resolves to { tokenId, url, tx }.
    async mint({ piece, epoch, step, hash }, onStatus = () => {}) {
      try {
        // the contract mints the chain's iteration for this epoch; make sure it's the one on screen
        if (hash && (await this.iteration(piece, epoch)).toLowerCase() !== hash.toLowerCase()) {
          throw new Error("This frame doesn't match the chain's iteration for that epoch, so it can't be minted.");
        }
        onStatus("Connecting a wallet…");
        const w = await wallet();
        const { price, active } = await this.piece(piece);
        if (!active) throw { data: "0x3aa301f8" };
        const tx = { from: w.from, to: cfg.contract, data: SEL.mint + word(piece) + word(epoch) + word(step), value: "0x" + price.toString(16) };
        await rpc("eth_call", [tx, "latest"]); // dry run: surface the contract's reason before the wallet prompt
        onStatus(w.dev ? "Minting (local dev account)…" : "Confirm in your wallet…");
        const txHash = await w.send(tx);
        onStatus("Waiting for the block…");
        for (let i = 0; i < 120; i++) {
          const rc = await rpc("eth_getTransactionReceipt", [txHash]);
          if (rc) {
            if (rc.status !== "0x1") throw new Error("The mint transaction failed.");
            const log = rc.logs.find((l) => l.address.toLowerCase() === cfg.contract.toLowerCase() && l.topics[0] === TRANSFER);
            const tokenId = BigInt(log.topics[3]);
            const url = await call(SEL.momentURL + word(tokenId)).then(decodeString, () => null);
            return { tokenId, url, tx: txHash };
          }
          await sleep(1000);
        }
        throw new Error("Timed out waiting for the transaction.");
      } catch (e) {
        throw new Error(reason(e));
      }
    },
  };
}

function decodeString(hex) {
  const w = words(hex);
  const len = Number("0x" + w[1]);
  const bytes = hex.slice(2 + 128, 2 + 128 + len * 2).match(/.{2}/g) || [];
  return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))));
}
