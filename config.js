/**
 * Конфигурация Solana Token Account Closer
 */

export const CONFIG = {
	// ===== RPC НАСТРОЙКИ =====
	// https://www.helius.dev/ - бесплатная приватная RPC

	RPC_ENDPOINT: 'https://api.mainnet-beta.solana.com',

	// ===== ФАЙЛЫ =====
	// Файл с приватными ключами (один на строку, формат Base58)
	WALLETS_FILE: 'wallets.txt',

	// Файл с приватным ключом основного кошелька (для режима FUND)
	FUND_FILE: 'fund.txt',

	// ===== ПРОИЗВОДИТЕЛЬНОСТЬ =====
	// Количество кошельков обрабатываемых параллельно
	PARALLEL_WALLETS: 3,

	// Количество аккаунтов в одной транзакции (при закрытии)
	BATCH_SIZE: 3,

	// Задержка между кошельками (мс)
	DELAY_BETWEEN_WALLETS: 1000,

	// Задержка между батчами транзакций (мс)
	DELAY_BETWEEN_BATCHES: 2000,

	// ===== ДОПОЛНИТЕЛЬНЫЕ НАСТРОЙКИ =====
	// Минимальный SOL баланс для включения в eligible_wallets.txt (SOL)
	MIN_CLAIMABLE_SOL: 0.001,

	// Комиссия на одну транзакцию (SOL) - для расчета при сборе
	TRANSACTION_FEE: 0.000005,

	// Минимальный баланс для отправки при сборе (SOL)
	MIN_BALANCE_TO_COLLECT: 0.00001,
}
