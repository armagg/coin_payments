interface Mock {
  req: Object
  res: Object
}

export function getNextNonceMocks (id: number, address: string, nonce: string): Mock {
  return {
    req: getNextNonceRequest(id, address),
    res: getNextNonceResponse(id, nonce)
  }
}

export function getBalanceMocks(id: number, address: string, balance: string): Mock {
  return {
    req: getBalanceRequest(id, address),
    res: getBalanceResponse(id, balance),
  }
}

export function getTransactionCountMocks(id: number, address: string, nonce: string): Mock {
  return {
    req: getTransactionCountRequest(id, address),
    res: getTransactionCountResponse(id, nonce)
  }
}

export function getSendRawTransactionMocks(id: number, rawTx: string, txHash: string): Mock {
  return {
    req: getSendRawTransactionRequest(id, rawTx),
    res: getSendRawTransactionResponse(id, txHash)
  }
}

export function getTransactionReceiptMocks(id: number, from: string, to: string, status: string, blockNumber: string | null, txHash: string, blockHash: string | null): Mock {
  return {
    req: getTransactionReceiptRequest(id, txHash),
    res: getTransactionReceiptResponse(id, from, to, status, blockNumber, txHash, blockHash)
  }
}

export function getTransactionByHashMocks(id: number, txHash: string, blockHash: string | null, blockNumber: number | null, from: string, to: string, value: string): Mock {
  return {
    req: getTransactionByHashRequest(id, txHash),
    res: getTransactionByHashResponse(id, txHash, blockHash, blockNumber, from, to, value)
  }
}

export function getBlockNumberMocks(id: number, count: string): Mock {
  return {
    req: getBlockNumberRequest(id),
    res: getBlockNumberResponse(id, count)
  }
}

export function getBlockByNumberMocks(id: number, blockNumber: string, blockHash: string, txHashes: [string]): Mock {
  return {
    req: getBlockByNumberRequest(id, blockNumber),
    res: getBlockByNumberResponse(id, blockNumber, blockHash, txHashes)
  }
}

export function getGasStationResponse(): Object {
  return {
    fast: 80,
    fastest: 100,
    safeLow: 10,
    average: 30,
    block_time: 14.422222222222222,
    blockNum: 9232596,
    speed: 0.6487309843669901,
    safeLowWait: 9.5,
    avgWait: 3.3,
    fastWait: 0.5,
    fastestWait: 0.5,
    gasPriceRange: {
      100: 0.5,
      95: 0.5,
      90: 0.5,
      85: 0.5,
      80: 0.5,
      75: 0.8,
      70: 0.8,
      65: 0.8,
      60: 0.9,
      55: 1,
      50: 1,
      45: 3.1,
      40: 3.1,
      35: 3.1,
      30: 3.3,
      25: 4.6,
      20: 4.6,
      15: 7.8,
      10: 9.5,
      8: 240.4,
      6: 240.4,
      4: 240.4
    }
  }
}

export function getGasPriceMocks(id: number, price: string) {
  return {
    req: {
      jsonrpc: '2.0',
      id,
      method: 'eth_gasPrice',
      params: [],
    },
    res: {
      jsonrpc: '2.0',
      id,
      result: price,
    }
  }
}

export function getEstimateGasMocks(id: number, from: string, to: string, result: string) {
  return {
    req: {
      jsonrpc:'2.0',
      id,
      method:'eth_estimateGas',
      params: [{
        from: from.toLowerCase(),
        to: to.toLowerCase()
      }],
    },
    res: {
      jsonrpc: '2.0',
      id,
      result
    }
  }
}
function getNextNonceRequest(id: number, address: string): Object {
  return {
    jsonrpc: '2.0',
    method:'parity_nextNonce',
    params: [address],
    id
  }
}

function getNextNonceResponse(id: number, nonce: string): Object {
  return {
    jsonrpc: '2.0',
    id,
    result: nonce,
  }
}

function getBalanceRequest(id: number, address: string): Object {
  return {
    jsonrpc:'2.0',
    id,
    method:'eth_getBalance',
    params: [address, 'latest'],
  }
}

function getBalanceResponse(id: number, balance: string): Object {
  return {
    jsonrpc:'2.0',
    id,
    result: balance
  }
}

function getTransactionCountRequest(id: number, address: string): Object {
  return {
    jsonrpc:'2.0',
    method:'eth_getTransactionCount',
    params: [address, 'pending'],
    id,
  }
}

function getTransactionCountResponse(id: number, nonce: string): Object {
  return {
    jsonrpc: '2.0',
    id,
    result: nonce
  }
}

function getSendRawTransactionRequest(id: number, rawTx: string): Object {
  return {
    jsonrpc: '2.0',
    method: 'eth_sendRawTransaction',
    params: [rawTx],
    id
  }
}

function getSendRawTransactionResponse(id: number, txHash: string): Object {
  return {
    jsonrpc: '2.0',
    id,
    result: txHash
  }
}

function getTransactionReceiptRequest(id: number, txHash: string): Object {
  return {
    jsonrpc: '2.0',
    id,
    method: 'eth_getTransactionReceipt',
    params: [txHash],
  }
}

function getTransactionReceiptResponse(id: number, from: string, to:string, status: string, blockNumber: string | null, txHash: string, blockHash: string | null): Object {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      from,
      to,
      status,
      transactionHash: txHash,
      transactionIndex: 0,
      blockHash,
      blockNumber,
      contractAddress: null,
      cumulativeGasUsed: 314159,
      gasUsed: 21000,
      logs: [ ],
    }
  }
}

function getTransactionByHashRequest(id: number, txHash: string): Object {
  return {
    jsonrpc: '2.0',
    id,
    method: 'eth_getTransactionByHash',
    params: [txHash],
  }
}

function getTransactionByHashResponse(id: number, txHash: string, blockHash: string | null, blockNumber: number | null, from: string, to: string, value: string): Object {
  return {
    jsonrpc:'2.0',
    id,
    result: {
      hash: txHash,
      nonce: 2,
      blockHash,
      blockNumber,
      transactionIndex: 0,
      from,
      to,
      value,
      gas: 21000,
      gasPrice: '2000000000000',
      input: '0x57cb2fc4'
    }
  }
}

function getBlockNumberRequest(id: number): Object {
  return {
    jsonrpc: '2.0',
    id,
    method:'eth_blockNumber',
    params: [],
  }
}

function getBlockNumberResponse(id: number, count: string): Object {
  return {
    jsonrpc:'2.0',
    id,
    result: count
  }
}

function getBlockByNumberRequest(id: number, blockNumber: string): Object {
  return {
    jsonrpc: '2.0',
    id,
    method:'eth_getBlockByNumber',
    params: [blockNumber, false],
  }
}

function getBlockByNumberResponse(id: number, blockNumber: string, blockHash: string, txHashes: [string]): Object {
  return {
    jsonrpc:'2.0',
    id,
    result: {
      number: 3,
      hash: blockHash,
      parentHash: '0x2302e1c0b972d00932deb5dab9eb2982f570597d9d42504c05d9c2147eaf9c88',
      nonce: '0xfb6e1a62d119228b',
      sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
      logsBloom: '0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      transactionsRoot: '0x3a1b03875115b79539e5bd33fb00d8f7b7cd61929d5a3c574f507b8acf415bee',
      stateRoot: '0xf1133199d44695dfa8fd1bcfe424d82854b5cebef75bddd7e40ea94cda515bcb',
      miner: '0x8888f1f195afa192cfee860698584c030f4c9db1',
      difficulty: '21345678965432',
      totalDifficulty: '324567845321',
      size: 616,
      extraData: '0x',
      gasLimit: 3141592,
      gasUsed: 21000,
      timestamp: 1429287689,
      transactions: txHashes,
      uncles: []
    }
  }
}

