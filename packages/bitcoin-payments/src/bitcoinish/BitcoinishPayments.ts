import {
  BasePayments,
  UtxoInfo,
  FeeRateType,
  FeeRate,
  AutoFeeLevels,
  Payport,
  ResolveablePayport,
  BalanceResult,
  FromTo,
  TransactionStatus,
  CreateTransactionOptions,
  BaseConfig,
  MaybePromise,
} from '@faast/payments-common'
import { isUndefined, Numeric, toBigNumber, assertType, isNumber } from '@faast/ts-common'
import { get } from 'lodash'
import * as t from 'io-ts'

import {
  BitcoinishUnsignedTransaction,
  BitcoinishSignedTransaction,
  BitcoinishBroadcastResult,
  BitcoinishTransactionInfo,
  BitcoinishPaymentsConfig,
  BitcoinishPaymentTx,
  BitcoinishTxOutput,
  BitcoinishTxOutputSatoshis,
  BitcoinishWeightedChangeOutput,
  PayportOutput,
} from './types'
import { sumUtxoValue, sortUtxos, isConfirmedUtxo, sha256FromHex } from './utils'
import { BitcoinishPaymentsUtils } from './BitcoinishPaymentsUtils'

export abstract class BitcoinishPayments<Config extends BaseConfig> extends BitcoinishPaymentsUtils
  implements BasePayments<
    Config,
    BitcoinishUnsignedTransaction,
    BitcoinishSignedTransaction,
    BitcoinishBroadcastResult,
    BitcoinishTransactionInfo
  > {
  minTxFee?: FeeRate
  dustThreshold: number // base denom
  networkMinRelayFee: number // base denom
  targetUtxoPoolSize: number
  minChangeSat: number

  constructor(config: BitcoinishPaymentsConfig) {
    super(config)
    this.decimals = config.decimals
    this.bitcoinjsNetwork = config.bitcoinjsNetwork
    this.minTxFee = config.minTxFee
    this.dustThreshold = config.dustThreshold
    this.networkMinRelayFee = config.networkMinRelayFee
    this.targetUtxoPoolSize = isUndefined(config.targetUtxoPoolSize) ? 1 : config.targetUtxoPoolSize
    const minChange = toBigNumber(isUndefined(config.minChange) ? 0 : config.minChange)
    if (minChange.lt(0)) {
      throw new Error(`invalid minChange amount ${config.minChange}, must be positive`)
    }
    this.minChangeSat = this.toBaseDenominationNumber(minChange)
  }

  abstract getFullConfig(): Config
  abstract getPublicConfig(): Config
  abstract getAccountId(index: number): string
  abstract getAccountIds(index?: number): string[]
  abstract getAddress(index: number): string
  abstract isValidAddress(address: string): MaybePromise<boolean>
  abstract signTransaction(tx: BitcoinishUnsignedTransaction): Promise<BitcoinishSignedTransaction>

  /**
   * Serialize the payment tx into an hex string format representing the unsigned transaction.
   *
   * By default return empty string because it's coin dependent. Implementors can override this
   * with coin specific implementation (eg using Psbt for bitcoin). If coin doesn't have an unsigned
   * serialized tx format (ie most coins other than BTC) then leave as empty string.
   */
  abstract serializePaymentTx(paymentTx: BitcoinishPaymentTx, fromIndex: number): Promise<string>

  async init() {}
  async destroy() {}

  requiresBalanceMonitor() {
    return false
  }

  isSweepableBalance(balance: Numeric): boolean {
    return this.toBaseDenominationNumber(balance) > this.networkMinRelayFee
  }

  async getPayport(index: number): Promise<Payport> {
    return { address: this.getAddress(index) }
  }

  async resolvePayport(payport: ResolveablePayport): Promise<Payport> {
    if (typeof payport === 'number') {
      return this.getPayport(payport)
    } else if (typeof payport === 'string') {
      if (!await this.isValidAddress(payport)) {
        throw new Error(`Invalid BTC address: ${payport}`)
      }
      return { address: payport }
    } else if (Payport.is(payport)) {
      if (!await this.isValidAddress(payport.address)) {
        throw new Error(`Invalid BTC payport.address: ${payport.address}`)
      }
      return payport
    } else {
      throw new Error('Invalid payport')
    }
  }

  async getBalance(payport: ResolveablePayport): Promise<BalanceResult> {
    const { address } = await this.resolvePayport(payport)
    const result = await this._retryDced(() => this.getApi().getAddressDetails(address, { details: 'basic' }))
    const confirmedBalance = this.toMainDenominationBigNumber(result.balance)
    const unconfirmedBalance = this.toMainDenominationBigNumber(result.unconfirmedBalance)
    const spendableBalance = confirmedBalance.plus(unconfirmedBalance)
    this.logger.debug('getBalance', address, confirmedBalance, unconfirmedBalance)
    return {
      confirmedBalance: confirmedBalance.toString(),
      unconfirmedBalance: unconfirmedBalance.toString(),
      spendableBalance: spendableBalance.toString(),
      sweepable: this.isSweepableBalance(spendableBalance),
      requiresActivation: false,
    }
  }

  usesUtxos() {
    return true
  }

  async getUtxos(payport: ResolveablePayport): Promise<UtxoInfo[]> {
    const { address } = await this.resolvePayport(payport)
    let utxosRaw = await this.getApi().getUtxosForAddress(address)
    const utxos: UtxoInfo[] = utxosRaw.map((data) => {
      const { value, height, lockTime } = data
      return {
        ...data,
        satoshis: Number.parseInt(value),
        value: this.toMainDenominationString(value),
        height: isUndefined(height) ? undefined : String(height),
        lockTime: isUndefined(lockTime) ? undefined : String(lockTime),
      }
    })
    return utxos
  }

  usesSequenceNumber() {
    return false
  }

  async getNextSequenceNumber() {
    return null
  }

  async resolveFromTo(from: number, to: ResolveablePayport): Promise<FromTo> {
    const fromPayport = await this.getPayport(from)
    const toPayport = await this.resolvePayport(to)
    return {
      fromAddress: fromPayport.address,
      fromIndex: from,
      fromExtraId: fromPayport.extraId,
      fromPayport,
      toAddress: toPayport.address,
      toIndex: typeof to === 'number' ? to : null,
      toExtraId: toPayport.extraId,
      toPayport,
    }
  }

  /** buildPaymentTx uses satoshi number for convenient math, but we want strings externally */
  private convertOutputsToExternalFormat(outputs: Array<{ address: string, satoshis: number }>): BitcoinishTxOutput[] {
    return outputs.map(({ address, satoshis }) => ({ address, value: this.toMainDenominationString(satoshis) }))
  }

  /**
   * Estimate the size of a tx in vbytes. Override this if the coin supports segwit, multisig, or any
   * non P2PKH style transaction. Default implementation assumes P2PKH.
   */
  estimateTxSize(
    inputCount: number,
    changeOutputCount: number,
    externalOutputAddresses: string[],
  ): number {
    return 10 + 148 * inputCount + 34 * (changeOutputCount + externalOutputAddresses.length)
  }

  /** Helper for calculateTxFeeSatoshis */
  private feeRateToSatoshis(
    { feeRate, feeRateType }: FeeRate,
    inputCount: number,
    changeOutputCount: number,
    externalOutputAddresses: string[],
  ): number {
    if (feeRateType === FeeRateType.BasePerWeight) {
      return Number.parseFloat(feeRate) * this.estimateTxSize(inputCount, changeOutputCount, externalOutputAddresses)
    } else if (feeRateType === FeeRateType.Main) {
      return this.toBaseDenominationNumber(feeRate)
    }
    return Number.parseFloat(feeRate)
  }

  /** Estimate the tx fee in satoshis */
  estimateTxFee(
    targetRate: FeeRate,
    inputCount: number,
    changeOutputCount: number,
    externalOutputAddresses: string[],
  ): number {
    let feeSat = this.feeRateToSatoshis(targetRate, inputCount, changeOutputCount, externalOutputAddresses)
    // Ensure calculated fee is above configured minimum
    if (this.minTxFee) {
      const minTxFeeSat = this.feeRateToSatoshis(this.minTxFee, inputCount, changeOutputCount, externalOutputAddresses)
      if (feeSat < minTxFeeSat) {
        this.logger.debug(`Using min tx fee of ${minTxFeeSat} sat (${this.minTxFee} sat/byte) instead of ${feeSat} sat`)
        feeSat = minTxFeeSat
      }
    }
    // Ensure calculated fee is above network relay minimum
    if (feeSat < this.networkMinRelayFee) {
      this.logger.debug(`Using network min relay fee of ${this.networkMinRelayFee} sat instead of ${feeSat} sat`)
      feeSat = this.networkMinRelayFee
    }
    const result = Math.ceil(feeSat)
    this.logger.debug(
      `Estimated fee of ${result} sat for target rate ${targetRate.feeRate} ${targetRate.feeRateType} on a tx with `
        + `${inputCount} inputs, ${externalOutputAddresses} external outputs, and ${changeOutputCount} change outputs`
    )
    return result
  }

  /**
   * Determine how many change outputs to add to a transaction given how many there are currently
   * and how many we intend to use. The goal is to keep at least `targetUtxoPoolSize` utxos available
   * at all times to increase availability.
   */
  private determineTargetChangeOutputCount(unusedUtxoCount: number, inputUtxoCount: number) {
    const remainingUtxoCount = unusedUtxoCount - inputUtxoCount
    return remainingUtxoCount < this.targetUtxoPoolSize
      ? this.targetUtxoPoolSize - remainingUtxoCount
      : 1
  }

  private selectInputUtxos(
    unusedUtxos: UtxoInfo[],
    outputTotal: number,
    outputAddresses: string[],
    feeRate: FeeRate,
    useAllUtxos: boolean,
    useUnconfirmedUtxos: boolean,
  ): { selectedUtxos: UtxoInfo[], selectedTotalSat: number, feeSat: number } {
    // Convert values to satoshis for convenient math
    const utxos: Array<UtxoInfo & { satoshis: number }> = []
    let utxosTotalSat = 0
    for (const utxo of unusedUtxos) {
      if (!useUnconfirmedUtxos && !isConfirmedUtxo(utxo)) {
        continue
      }
      const satoshis = isUndefined(utxo.satoshis)
        ? this.toBaseDenominationNumber(utxo.value)
        : toBigNumber(utxo.satoshis).toNumber()
      utxosTotalSat += satoshis
      utxos.push({
        ...utxo,
        satoshis,
      })
    }

    if (useAllUtxos) { // Sweeping case
      return {
        selectedUtxos: utxos,
        selectedTotalSat: utxosTotalSat,
        feeSat: this.estimateTxFee(feeRate, utxos.length, 0, outputAddresses)
      }
    } else { // Sending amount case
      // First try to find a single input that covers output without creating change
      const idealSolutionFeeSat = this.estimateTxFee(feeRate, 1, 0, outputAddresses)
      const idealSolutionMinSat = outputTotal + idealSolutionFeeSat
      const idealSolutionMaxSat = idealSolutionMinSat + this.dustThreshold
      for (const utxo of utxos) {
        if (utxo.satoshis >= idealSolutionMinSat && utxo.satoshis <= idealSolutionMaxSat) {
          this.logger.log(
            `Found ideal ${this.coinSymbol} input utxo solution to send ${outputTotal} sat using single utxo ${utxo.txid}:${utxo.vout}`
          )
          return {
            selectedUtxos: [utxo],
            selectedTotalSat: utxo.satoshis,
            feeSat: idealSolutionFeeSat,
          }
        }
      }

      // Incrementally select utxos until we cover output + fees
      let selectedUtxos = []
      let selectedTotalSat = 0 // Total input sat is accumulated as inputs are added
      let feeSat = 0 // Total fee is recalculated when adding each input
      const sortedUtxos = sortUtxos(utxos)
      for (const utxo of sortedUtxos) {
        selectedUtxos.push(utxo)
        selectedTotalSat += utxo.satoshis
        const targetChangeOutputCount = this.determineTargetChangeOutputCount(unusedUtxos.length, selectedUtxos.length)
        feeSat = this.estimateTxFee(feeRate, selectedUtxos.length, targetChangeOutputCount, outputAddresses)
        if (selectedTotalSat >= outputTotal + feeSat) {
          break
        }
      }
      return {
        selectedUtxos,
        selectedTotalSat,
        feeSat,
      }
    }
  }

  /**
   * Build a simple payment transaction.
   * Note: fee will be subtracted from first output when attempting to send entire account balance
   * Note: All amounts/values should be input and output as main denomination strings for consistent
   * serialization. Within this function they're converted to JS Numbers for convenient arithmetic
   * then converted back to strings before being returned.
   */
  async buildPaymentTx(params: {
    unusedUtxos: UtxoInfo[], // Utxos not already taken by pending txs
    desiredOutputs: BitcoinishTxOutput[],
    changeAddress: string,
    desiredFeeRate: FeeRate,
    useAllUtxos?: boolean,
    useUnconfirmedUtxos?: boolean, // true if unconfirmed utxos should be used
  }): Promise<Required<BitcoinishPaymentTx>> {
    const {
      unusedUtxos, desiredOutputs, changeAddress, desiredFeeRate,
    } = params
    const useAllUtxos = isUndefined(params.useAllUtxos) ? false : params.useAllUtxos
    const useUnconfirmedUtxos = isUndefined(params.useUnconfirmedUtxos) ? false : params.useUnconfirmedUtxos
    // sum of non change output value in satoshis
    let externalOutputTotal = 0
    // Convert output values to satoshis for convenient math
    const externalOutputs: BitcoinishTxOutputSatoshis[] = []
    for (let i = 0; i < desiredOutputs.length; i++) {
      const { address, value } = desiredOutputs[i]
      // validate
      if (!await this.isValidAddress(address)) {
        throw new Error(`Invalid ${this.coinSymbol} address ${address} provided for output ${i}`)
      }
      const satoshis = this.toBaseDenominationNumber(value)
      if (isNaN(satoshis)) {
        throw new Error(`Invalid ${this.coinSymbol} value (${value}) provided to createMultiOutputTransaction output ${i} (${address})`)
      }
      if (satoshis <= 0) {
        throw new Error(`Invalid ${this.coinSymbol} positive value (${value}) provided for output ${i} (${address})`)
      }
      externalOutputs.push({ address, satoshis })
      externalOutputTotal += satoshis
    }
    if (!await this.isValidAddress(changeAddress)) {
      throw new Error (`Invalid ${this.coinSymbol} change address ${changeAddress} provided`)
    }

    /* Select inputs and calculate appropriate fee */
    const externalOutputAddresses = externalOutputs.map(({ address }) => address)
    let { selectedUtxos: inputUtxos, selectedTotalSat: inputTotal, feeSat } = this.selectInputUtxos(
      unusedUtxos,
      externalOutputTotal,
      externalOutputAddresses,
      desiredFeeRate,
      useAllUtxos,
      useUnconfirmedUtxos,
    )

    /** Account for insuffient inputs and sweeping cases */
    if (externalOutputTotal + feeSat > inputTotal) {
      if (externalOutputTotal === inputTotal) { // sweeping
        // Share the fee across all outputs. This may increase the fee by as much as 1 sat per output, negligible
        const feeShare = Math.ceil(feeSat / externalOutputs.length)
        feeSat = feeShare * externalOutputs.length
        this.logger.log(
          `${this.coinSymbol} buildPaymentTx - Attempting to send entire ${externalOutputTotal} sat balance. ` +
          `Subtracting fee of ${feeSat} sat from ${externalOutputs.length} outputs (${feeShare} sat each)`
        )
        for (let i = 0; i < externalOutputs.length; i++) {
          const externalOutput = externalOutputs[i]
          externalOutput.satoshis -= feeShare
          if (externalOutput.satoshis <= this.dustThreshold) {
            throw new Error(
              `${this.coinSymbol} buildPaymentTx - output ${i} for ${externalOutput.satoshis} ` +
              `sat minus ${feeShare} sat fee share is below dust threshold`
            )
          }
        }
        externalOutputTotal -= feeSat
      } else { // insufficient utxos
        throw new Error(
          `${this.coinSymbol} buildPaymentTx - You do not have enough UTXOs (${inputTotal} sat) ` +
          `to send ${externalOutputTotal} sat with ${feeSat} sat fee`
        )
      }
    }

    /** Change handling */

    let totalChangeSat = inputTotal - externalOutputTotal - feeSat

    this.logger.debug('buildPaymentTx', { inputTotal, feeSat, outputTotal: externalOutputTotal, totalChangeSat })
    let changeOutputs: BitcoinishTxOutputSatoshis[] = []
    if (totalChangeSat < 0) {
      throw new Error(`${this.coinSymbol} buildPaymentTx - totalChangeSat is negative when building tx, this shouldnt happen!`)
    } else {
      const targetChangeOutputCount = this.determineTargetChangeOutputCount(unusedUtxos.length, inputUtxos.length)
      const changeOutputWeights = this.createWeightedChangeOutputs(targetChangeOutputCount, changeAddress)
      const totalChangeWeight = changeOutputWeights.reduce((total, { weight }) => total += weight, 0)
      let totalChangeAllocated = 0 // Total sat of all change outputs we actually include (omitting dust)
      for (let i = 0; i < changeOutputWeights.length; i++) {
        const { address, weight } = changeOutputWeights[i]
        // Distribute change proportional to each change outputs weight. Floored to not exceed inputTotal
        const changeSat = Math.floor(totalChangeSat * (weight / totalChangeWeight))
        if (changeSat <= this.dustThreshold || changeSat < this.minChangeSat) {
          this.logger.log(
            `${this.coinSymbol} buildPaymentTx - desired change output ${i} is below dust threshold or minChange, ` +
            'will redistribute to other change outputs or add to fee'
          )
        } else {
          changeOutputs.push({ address, satoshis: changeSat })
          totalChangeAllocated += changeSat
        }
      }
      this.logger.debug({ changeOutputWeights, totalChangeWeight, totalChangeAllocated, changeOutputs })

      // If due to rounding or omitting dust outputs our real change total is different, adjust fees accordingly
      let looseChange = totalChangeSat - totalChangeAllocated
      const recalculatedFee = this.estimateTxFee(
        desiredFeeRate,
        inputUtxos.length,
        changeOutputs.length || 1,
        externalOutputAddresses,
      )
      if (feeSat > recalculatedFee) {
        // Due to dropping change outputs we're now overpaying, reduce fee and reallocate to change
        const overpayingAmount = feeSat - recalculatedFee
        this.logger.debug(`Reducing overestimated fee ${feeSat} by ${overpayingAmount} sat`)
        feeSat = recalculatedFee
        totalChangeSat += overpayingAmount
        looseChange += overpayingAmount
      }
      if (looseChange < 0) {
        throw new Error(`${this.coinSymbol} buildPaymentTx - looseChange should never be negative!`)
      } else if (changeOutputs.length > 0 && looseChange / changeOutputs.length > 1) {
        // Enough loose change to reallocate amongst all change outputs
        const extraSatPerChangeOutput = Math.floor(looseChange / changeOutputs.length)
        this.logger.log(`${this.coinSymbol} buildPaymentTx - redistributing looseChange of ${extraSatPerChangeOutput} per change output`)
        for (let i = 0; i < changeOutputs.length; i++) {
          changeOutputs[i].satoshis += extraSatPerChangeOutput
        }
        looseChange -= extraSatPerChangeOutput * changeOutputs.length
      } else if (changeOutputs.length === 0 && looseChange > this.dustThreshold) {
        this.logger.log(`${this.coinSymbol} buildPaymentTx - allocated looseChange towards single ${looseChange} sat change output`)
        changeOutputs.push({ address: changeAddress, satoshis: looseChange })
        looseChange = 0
      }
      feeSat += looseChange
      totalChangeSat -= looseChange
    }
    const externalOutputsResult = this.convertOutputsToExternalFormat(externalOutputs)
    const changeOutputsResult = this.convertOutputsToExternalFormat(changeOutputs)
    const outputsResult = [...externalOutputsResult, ...changeOutputsResult]
    return {
      inputs: inputUtxos,
      outputs: outputsResult,
      fee: this.toMainDenominationString(feeSat),
      change: this.toMainDenominationString(totalChangeSat),
      changeAddress: changeOutputs.length === 1 ? changeOutputs[0].address : null, // back compat
      changeOutputs: changeOutputsResult,
      externalOutputs: externalOutputsResult,
      externalOutputTotal: this.toMainDenominationString(externalOutputTotal),
      rawHex: '',
      rawHash: '',
    }
  }

  /**
   * Creates a list of change addresses with an exponential weight distribution to use for
   * maintaining a pool of utxos.
   */
  private createWeightedChangeOutputs(
    changeOutputCount: number,
    changeAddress: string,
  ): BitcoinishWeightedChangeOutput[] {
    const result: BitcoinishWeightedChangeOutput[] = []
    for (let i = 0; i < changeOutputCount; i++) {
      result.push({ address: changeAddress, weight: 2 ** i })
    }
    return result
  }

  async createTransaction(
    from: number,
    to: ResolveablePayport,
    amount: Numeric,
    options?: CreateTransactionOptions,
  ): Promise<BitcoinishUnsignedTransaction> {
    return this.createMultiOutputTransaction(from, [{ payport: to, amount }], options)
  }

  async createMultiOutputTransaction(
    from: number,
    to: PayportOutput[],
    options: CreateTransactionOptions = {},
  ): Promise<BitcoinishUnsignedTransaction> {
    assertType(t.array(PayportOutput), to)
    this.logger.debug('createMultiOutputTransaction', from, to, options)

    const unusedUtxos = options.utxos || await this.getUtxos(from)
    this.logger.debug('createMultiOutputTransaction unusedUtxos', unusedUtxos)

    const { address: fromAddress } = await this.resolvePayport(from)

    const desiredOutputs = await Promise.all(to.map(async ({ payport, amount }) => ({
      address: (await this.resolvePayport(payport)).address,
      value: String(amount),
    })))

    const { targetFeeLevel, targetFeeRate, targetFeeRateType } = await this.resolveFeeOption(options)
    this.logger.debug(`createMultiOutputTransaction resolvedFeeOption ${targetFeeLevel} ${targetFeeRate} ${targetFeeRateType}`)

    const paymentTx = await this.buildPaymentTx({
      unusedUtxos,
      desiredOutputs,
      changeAddress: fromAddress,
      desiredFeeRate: { feeRate: targetFeeRate, feeRateType: targetFeeRateType },
      useAllUtxos: options.useAllUtxos,
      useUnconfirmedUtxos: options.useUnconfirmedUtxos,
    })
    const unsignedTxHex = await this.serializePaymentTx(paymentTx, from)
    paymentTx.rawHex = unsignedTxHex
    paymentTx.rawHash = sha256FromHex(unsignedTxHex)
    this.logger.debug('createMultiOutputTransaction data', paymentTx)
    const feeMain = paymentTx.fee

    let resultToAddress = 'multiout'
    let resultToIndex = null
    if (paymentTx.externalOutputs.length === 1) {
      const onlyOutput = paymentTx.externalOutputs[0]
      resultToAddress = onlyOutput.address
      resultToIndex = isNumber(to[0].payport) ? to[0].payport : null
    }

    return {
      status: TransactionStatus.Unsigned,
      id: null,
      fromIndex: from,
      fromAddress,
      fromExtraId: null,
      toIndex: resultToIndex,
      toAddress: resultToAddress,
      toExtraId: null,
      amount: paymentTx.externalOutputTotal,
      targetFeeLevel,
      targetFeeRate,
      targetFeeRateType,
      fee: feeMain,
      sequenceNumber: null,
      inputUtxos: paymentTx.inputs,
      externalOutputs: paymentTx.externalOutputs,
      data: paymentTx,
    }
  }

  async createServiceTransaction(
    from: number,
    options: CreateTransactionOptions = {},
  ): Promise<null> {
    return null
  }

  async createSweepTransaction(
    from: number,
    to: ResolveablePayport,
    options: CreateTransactionOptions = {},
  ): Promise<BitcoinishUnsignedTransaction> {
    this.logger.debug('createSweepTransaction', from, to, options)

    const availableUtxos = isUndefined(options.utxos)
      ? await this.getUtxos(from)
      : options.utxos

    if (availableUtxos.length === 0) {
      throw new Error('No available utxos to sweep')
    }
    const useUnconfirmedUtxos = isUndefined(options.useUnconfirmedUtxos) ? true : options.useUnconfirmedUtxos
    const outputAmount = sumUtxoValue(availableUtxos, useUnconfirmedUtxos)
    if (!this.isSweepableBalance(outputAmount)) {
      throw new Error(`Available utxo total ${outputAmount} ${this.coinSymbol} too low to sweep`)
    }
    const updatedOptions = {
      ...options,
      useUnconfirmedUtxos,
      utxos: availableUtxos,
      useAllUtxos: true,
    }
    return this.createTransaction(from, to, outputAmount, updatedOptions)
  }

  async broadcastTransaction(tx: BitcoinishSignedTransaction): Promise<BitcoinishBroadcastResult> {
    let txId: string
    try {
      txId = await this._retryDced(() => this.getApi().sendTx(tx.data.hex))
      if (tx.id !== txId) {
        this.logger.warn(`Broadcasted ${this.coinSymbol} txid ${txId} doesn't match original txid ${tx.id}`)
      }
    } catch(e) {
      const message = e.message || ''
      if (message.startsWith('-27')) {
        txId = tx.id
      } else {
        throw e
      }
    }
    return {
      id: tx.id,
    }
  }

  async getTransactionInfo(txId: string): Promise<BitcoinishTransactionInfo> {
    const tx = await this._retryDced(() => this.getApi().getTx(txId))
    const fee = this.toMainDenominationString(tx.fees)
    const confirmationId = tx.blockHash || null
    const confirmationNumber = tx.blockHeight ? String(tx.blockHeight) : undefined
    const confirmationTimestamp = tx.blockTime ? new Date(tx.blockTime * 1000) : null
    const isConfirmed = Boolean(tx.confirmations && tx.confirmations > 0)
    const status = isConfirmed ? TransactionStatus.Confirmed : TransactionStatus.Pending
    const amountSat = get(tx, 'vout.0.value', tx.value)
    const amount = this.toMainDenominationString(amountSat)
    const fromAddress = get(tx, 'vin.0.addresses.0')
    if (!fromAddress) {
      throw new Error(`Unable to determine fromAddress of ${this.coinSymbol} tx ${txId}`)
    }
    const toAddress = get(tx, 'vout.0.addresses.0')
    if (!toAddress) {
      throw new Error(`Unable to determine toAddress of ${this.coinSymbol} tx ${txId}`)
    }

    return {
      status,
      id: tx.txid,
      fromIndex: null,
      fromAddress,
      fromExtraId: null,
      toIndex: null,
      toAddress,
      toExtraId: null,
      amount,
      fee,
      sequenceNumber: null,
      confirmationId,
      confirmationNumber,
      confirmationTimestamp,
      isExecuted: isConfirmed,
      isConfirmed,
      confirmations: tx.confirmations,
      data: tx,
    }
  }
}
