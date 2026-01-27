import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  Token
} from '@solana/spl-token';
import bs58 from 'bs58';
import fs from 'fs';
import readline from 'readline';
import { CONFIG } from './config.js';

/**
 * Solana Token Account Closer
 * Публичная версия для массового закрытия Token Accounts
 */

// ===== УТИЛИТЫ =====

/**
 * Парсит приватный ключ из строки
 */
function parsePrivateKey(line) {
  line = line.trim();

  if (!line || line.startsWith('#')) {
    return null;
  }

  try {
    const decoded = bs58.decode(line);
    return { keypair: Keypair.fromSecretKey(decoded), originalString: line };
  } catch {
    return null;
  }
}

/**
 * Загружает кошельки из файла
 */
function loadWallets() {
  if (!fs.existsSync(CONFIG.WALLETS_FILE)) {
    console.error(`❌ Файл ${CONFIG.WALLETS_FILE} не найден!`);
    console.log(`Создайте файл ${CONFIG.WALLETS_FILE} и добавьте приватные ключи (один на строку)`);
    process.exit(1);
  }

  const content = fs.readFileSync(CONFIG.WALLETS_FILE, 'utf-8');
  const lines = content.split('\n');
  const wallets = [];

  for (let i = 0; i < lines.length; i++) {
    const parsed = parsePrivateKey(lines[i]);
    if (parsed) {
      wallets.push({
        index: wallets.length,
        keypair: parsed.keypair,
        address: parsed.keypair.publicKey.toString(),
        privateKeyString: parsed.originalString,
        lineNumber: i + 1
      });
    }
  }

  return wallets;
}

/**
 * Создает readline interface для интерактивного ввода
 */
function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

/**
 * Задает вопрос пользователю
 */
function question(rl, query) {
  return new Promise(resolve => rl.question(query, resolve));
}

// ===== РЕЖИМ 1: CHECK - ПРОВЕРКА КОШЕЛЬКОВ =====

async function checkMode() {
  console.log('\n🔍 РЕЖИМ ПРОВЕРКИ');
  console.log('═'.repeat(80));

  const wallets = loadWallets();
  console.log(`📂 Загружено кошельков: ${wallets.length}\n`);

  const connection = new Connection(CONFIG.RPC_ENDPOINT, 'confirmed');
  const eligibleWallets = [];
  let totalClaimable = 0;

  console.log('Проверяю кошельки...\n');

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const walletNum = i + 1;

    try {
      // Получаем Token Accounts
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.keypair.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      // Считаем пустые аккаунты
      let emptyAccounts = 0;
      for (const account of tokenAccounts.value) {
        const balance = account.account.data.parsed.info.tokenAmount.uiAmount;

        if (balance === 0) {
          emptyAccounts++;
        }
      }

      const claimableSOL = emptyAccounts * 0.00203928;

      if (claimableSOL > 0) {
        console.log(`✅ Кошелёк ${walletNum}/${wallets.length}: ${claimableSOL.toFixed(6)} SOL (${emptyAccounts} токенов)`);

        eligibleWallets.push({
          address: wallet.address,
          privateKey: wallet.privateKeyString,
          claimableSOL: claimableSOL,
          emptyAccounts: emptyAccounts
        });

        totalClaimable += claimableSOL;
      } else {
        console.log(`⚪ Кошелёк ${walletNum}/${wallets.length}: 0 SOL`);
      }

      // Задержка между кошельками
      if (i < wallets.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_BETWEEN_WALLETS));
      }

    } catch (error) {
      console.log(`❌ Кошелёк ${walletNum}/${wallets.length}: Ошибка - ${error.message}`);
    }
  }

  // Сохраняем eligible wallets
  console.log('\n' + '═'.repeat(80));
  console.log('📊 РЕЗУЛЬТАТЫ ПРОВЕРКИ');
  console.log('═'.repeat(80));
  console.log(`✅ Кошельков с SOL: ${eligibleWallets.length}/${wallets.length}`);
  console.log(`💰 Всего можно вернуть: ${totalClaimable.toFixed(6)} SOL`);

  if (eligibleWallets.length > 0) {
    const keysFile = 'eligible_wallets_keys.txt';
    const addressFile = 'eligible_wallets_address.txt';

    fs.writeFileSync(keysFile, eligibleWallets.map(w => w.privateKey).join('\n') + '\n');
    fs.writeFileSync(addressFile, eligibleWallets.map(w => w.address).join('\n') + '\n');

    console.log(`\n💾 Сохранено: ${eligibleWallets.length} кошельков`);
    console.log(`🔑 Приватники: ${keysFile}`);
    console.log(`📍 Адреса:     ${addressFile}`);
    console.log(`\n💡 Далее используйте режим FUND для пополнения, затем CLAIM`);
  } else {
    console.log(`\n⚠️  Нет кошельков с пустыми Token Accounts`);
  }
}

// ===== РЕЖИМ 2: CLAIM - ВОЗВРАТ SOL =====

async function claimMode() {
  console.log('\n💰 РЕЖИМ ВОЗВРАТА SOL');
  console.log('═'.repeat(80));
  console.log('⚠️  ВАЖНО: На каждом кошельке должно быть > 0.001 SOL для комиссий!');
  console.log('═'.repeat(80));

  const wallets = loadWallets();
  console.log(`\n📂 Загружено кошельков: ${wallets.length}\n`);

  const connection = new Connection(CONFIG.RPC_ENDPOINT, 'confirmed');

  const stats = {
    processed: 0,
    successful: 0,
    failed: 0,
    totalClosed: 0,
    totalRecovered: 0,
  };

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const walletNum = i + 1;

    try {
      // Проверяем баланс SOL
      const solBalance = await connection.getBalance(wallet.keypair.publicKey);
      const solBalanceFormatted = (solBalance / 1e9).toFixed(6);

      if (solBalance < 1000000) { // 0.001 SOL
        console.log(`⚠️  Кошелёк ${walletNum}/${wallets.length}: недостаточно SOL (${solBalanceFormatted})`);
        stats.failed++;
        stats.processed++;
        continue;
      }

      // Получаем Token Accounts
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.keypair.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      // Фильтруем аккаунты для закрытия
      const accountsToClose = [];
      for (const account of tokenAccounts.value) {
        const accountInfo = account.account.data.parsed.info;
        const balance = accountInfo.tokenAmount.uiAmount;

        if (balance === 0) {
          accountsToClose.push(account.pubkey);
        }
      }

      if (accountsToClose.length === 0) {
        console.log(`⚪ Кошелёк ${walletNum}/${wallets.length}: нет токенов для закрытия`);
        stats.processed++;
        continue;
      }

      console.log(`🔄 Кошелёк ${walletNum}/${wallets.length}: закрываю ${accountsToClose.length} токенов...`);

      let closed = 0;

      // Закрываем батчами
      for (let j = 0; j < accountsToClose.length; j += CONFIG.BATCH_SIZE) {
        const batch = accountsToClose.slice(j, j + CONFIG.BATCH_SIZE);

        try {
          const transaction = new Transaction();

          for (const accountPubkey of batch) {
            transaction.add(
              Token.createCloseAccountInstruction(
                TOKEN_PROGRAM_ID,
                accountPubkey,
                wallet.keypair.publicKey,
                wallet.keypair.publicKey,
                []
              )
            );
          }

          const signature = await sendAndConfirmTransaction(
            connection,
            transaction,
            [wallet.keypair],
            { commitment: 'confirmed', skipPreflight: false, maxRetries: 3 }
          );

          closed += batch.length;
          console.log(`  ✅ Батч ${Math.floor(j / CONFIG.BATCH_SIZE) + 1}: ${batch.length} токенов закрыто (${signature.substring(0, 12)}...)`);

        } catch (error) {
          console.log(`  ❌ Батч упал, пробую по одному...`);

          // Пробуем по одному
          for (const accountPubkey of batch) {
            try {
              const tx = new Transaction().add(
                Token.createCloseAccountInstruction(
                  TOKEN_PROGRAM_ID,
                  accountPubkey,
                  wallet.keypair.publicKey,
                  wallet.keypair.publicKey,
                  []
                )
              );

              await sendAndConfirmTransaction(connection, tx, [wallet.keypair], { commitment: 'confirmed' });
              closed++;
              console.log(`  ✅ Токен закрыт`);
            } catch (singleError) {
              console.log(`  ❌ Ошибка: ${singleError.message}`);
            }
          }
        }

        // Задержка между батчами
        if (j + CONFIG.BATCH_SIZE < accountsToClose.length) {
          await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_BETWEEN_BATCHES));
        }
      }

      const recovered = closed * 0.00203928;
      stats.totalClosed += closed;
      stats.totalRecovered += recovered;

      if (closed > 0) {
        stats.successful++;
        console.log(`  💰 Возвращено: ${recovered.toFixed(6)} SOL (${closed}/${accountsToClose.length})`);
      } else {
        stats.failed++;
      }

      stats.processed++;

      // Задержка между кошельками
      if (i < wallets.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_BETWEEN_WALLETS));
      }

    } catch (error) {
      console.log(`❌ Кошелёк ${walletNum}/${wallets.length}: ${error.message}`);
      stats.failed++;
      stats.processed++;
    }
  }

  // Итоги
  console.log('\n' + '═'.repeat(80));
  console.log('🎉 ЗАВЕРШЕНО!');
  console.log('═'.repeat(80));
  console.log(`📊 Обработано: ${stats.processed}/${wallets.length}`);
  console.log(`✅ Успешно: ${stats.successful}`);
  console.log(`❌ Ошибок: ${stats.failed}`);
  console.log(`📦 Закрыто токенов: ${stats.totalClosed}`);
  console.log(`💰 ВОЗВРАЩЕНО: ${stats.totalRecovered.toFixed(6)} SOL`);

}

// ===== РЕЖИМ 3: FUND - РАЗДАЧА SOL НА КОШЕЛЬКИ =====

async function fundMode() {
  console.log('\n💸 РЕЖИМ РАЗДАЧИ SOL');
  console.log('═'.repeat(80));

  // Загружаем основной кошелек из fund.txt
  const fundFile = CONFIG.FUND_FILE;
  if (!fs.existsSync(fundFile)) {
    console.error(`❌ Файл ${fundFile} не найден!`);
    console.log(`Создайте файл ${fundFile} и добавьте приватный ключ основного кошелька`);
    return;
  }

  const fundContent = fs.readFileSync(fundFile, 'utf-8').trim();
  const fundParsed = parsePrivateKey(fundContent.split('\n')[0]);

  if (!fundParsed) {
    console.error('❌ Неверный приватный ключ в fund.txt!');
    return;
  }

  const fundKeypair = fundParsed.keypair;
  const connection = new Connection(CONFIG.RPC_ENDPOINT, 'confirmed');

  // Баланс основного кошелька
  const fundBalance = await connection.getBalance(fundKeypair.publicKey);
  const fundBalanceSOL = fundBalance / 1e9;

  console.log(`\n🏦 Основной кошелёк: ${fundKeypair.publicKey.toString()}`);
  console.log(`💰 Баланс: ${fundBalanceSOL.toFixed(6)} SOL`);

  // Загружаем адреса получателей из eligible_wallets_address.txt
  const addressFile = 'eligible_wallets_address.txt';
  if (!fs.existsSync(addressFile)) {
    console.error(`\n❌ Файл ${addressFile} не найден!`);
    console.log('Сначала запустите режим CHECK для создания этого файла');
    return;
  }

  const addresses = fs.readFileSync(addressFile, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  console.log(`📂 Кошельков для пополнения: ${addresses.length}`);

  // Запрашиваем сумму
  const rl = createInterface();
  const amountStr = await question(rl, `\nСколько SOL отправить на каждый кошелёк?(рекомендуется 0.001): `);
  const amountSOL = parseFloat(amountStr.trim());

  if (isNaN(amountSOL) || amountSOL <= 0) {
    console.error('❌ Неверная сумма!');
    rl.close();
    return;
  }

  const totalNeeded = amountSOL * addresses.length;
  const totalWithFees = totalNeeded + (CONFIG.TRANSACTION_FEE * addresses.length);

  console.log(`\n📊 Расчёт:`);
  console.log(`${amountSOL} SOL × ${addresses.length} кошельков = ${totalNeeded.toFixed(6)} SOL`);
  console.log(`Комиссии: ~${(CONFIG.TRANSACTION_FEE * addresses.length).toFixed(6)} SOL`);
  console.log(`Итого нужно: ~${totalWithFees.toFixed(6)} SOL`);
  console.log(`Баланс: ${fundBalanceSOL.toFixed(6)} SOL`);

  if (totalWithFees > fundBalanceSOL) {
    console.log(`\n❌ Недостаточно SOL! Не хватает ~${(totalWithFees - fundBalanceSOL).toFixed(6)} SOL`);
    console.log(`Пополните кошелёк и попробуйте снова.`);
    rl.close();
    return;
  }

  const confirm = await question(rl, '\nПродолжить? (y/n): ');
  rl.close();

  if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
    console.log('❌ Отменено');
    return;
  }

  console.log('');

  const lamportsToSend = Math.floor(amountSOL * 1e9);

  const stats = {
    successful: 0,
    failed: 0,
    totalSent: 0
  };

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i];
    const walletNum = i + 1;

    try {
      const recipientPubkey = new PublicKey(address);

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: fundKeypair.publicKey,
          toPubkey: recipientPubkey,
          lamports: lamportsToSend
        })
      );

      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [fundKeypair],
        { commitment: 'confirmed' }
      );

      stats.successful++;
      stats.totalSent += amountSOL;
      console.log(`✅ ${walletNum}/${addresses.length}: ${amountSOL} SOL -> ${address.substring(0, 12)}... (${signature.substring(0, 12)}...)`);

    } catch (error) {
      stats.failed++;
      console.log(`❌ ${walletNum}/${addresses.length}: ${error.message}`);
    }

    // Задержка между транзакциями
    if (i < addresses.length - 1) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_BETWEEN_WALLETS));
    }
  }

  // Итоги
  console.log('\n' + '═'.repeat(80));
  console.log('🎉 РАЗДАЧА ЗАВЕРШЕНА!');
  console.log('═'.repeat(80));
  console.log(`✅ Успешно: ${stats.successful}/${addresses.length}`);
  console.log(`❌ Ошибок: ${stats.failed}`);
  console.log(`💰 Отправлено: ${stats.totalSent.toFixed(6)} SOL`);

  // Показываем остаток на основном кошельке
  const remainingBalance = await connection.getBalance(fundKeypair.publicKey);
  console.log(`🏦 Остаток на основном: ${(remainingBalance / 1e9).toFixed(6)} SOL`);
}

// ===== РЕЖИМ 4: COLLECT - СБОР SOL НА ОДИН КОШЕЛЕК =====

async function collectMode() {
  console.log('\n📥 РЕЖИМ СБОРА SOL НА ОДИН КОШЕЛЕК');
  console.log('═'.repeat(80));

  // Загружаем адрес получателя из fund.txt
  const fundFile = CONFIG.FUND_FILE;
  if (!fs.existsSync(fundFile)) {
    console.error(`❌ Файл ${fundFile} не найден!`);
    console.log(`Создайте файл ${fundFile} и добавьте приватный ключ основного кошелька`);
    return;
  }

  const fundContent = fs.readFileSync(fundFile, 'utf-8').trim();
  const fundParsed = parsePrivateKey(fundContent.split('\n')[0]);

  if (!fundParsed) {
    console.error('❌ Неверный приватный ключ в fund.txt!');
    return;
  }

  const recipientPubkey = fundParsed.keypair.publicKey;

  console.log(`\n📍 Получатель (fund.txt): ${recipientPubkey.toString()}`);

  const rl = createInterface();
  const confirm = await question(rl, '\nСобрать всю SOL на этот кошелёк? (y/n): ');
  rl.close();

  if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
    console.log('❌ Отменено');
    return;
  }

  const wallets = loadWallets();
  console.log(`\n📂 Загружено кошельков: ${wallets.length}\n`);

  const connection = new Connection(CONFIG.RPC_ENDPOINT, 'confirmed');

  const stats = {
    processed: 0,
    successful: 0,
    skipped: 0,
    totalCollected: 0,
    totalFees: 0
  };

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const walletNum = i + 1;

    try {
      const balance = await connection.getBalance(wallet.keypair.publicKey);
      const balanceSOL = balance / 1e9;

      // Пропускаем если баланс меньше минимума
      if (balanceSOL < CONFIG.MIN_BALANCE_TO_COLLECT) {
        console.log(`⚪ Кошелёк ${walletNum}/${wallets.length}: пропущен (баланс ${balanceSOL.toFixed(6)} SOL)`);
        stats.skipped++;
        stats.processed++;
        continue;
      }

      // Рассчитываем сумму: отправляем всё минус 5000 lamports (комиссия)
      // Чтобы после транзакции баланс стал ровно 0
      const FEE_LAMPORTS = 5000;
      const amountToSend = balance - FEE_LAMPORTS;

      if (amountToSend <= 0) {
        console.log(`⚠️  Кошелёк ${walletNum}/${wallets.length}: недостаточно для отправки`);
        stats.skipped++;
        stats.processed++;
        continue;
      }

      console.log(`🔄 Кошелёк ${walletNum}/${wallets.length}: отправляю ${(amountToSend / 1e9).toFixed(6)} SOL...`);

      // Создаем транзакцию
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.keypair.publicKey,
          toPubkey: recipientPubkey,
          lamports: amountToSend
        })
      );

      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet.keypair],
        { commitment: 'confirmed' }
      );

      stats.successful++;
      stats.totalCollected += amountToSend / 1e9;
      stats.totalFees += CONFIG.TRANSACTION_FEE;

      console.log(`  ✅ Отправлено ${(amountToSend / 1e9).toFixed(6)} SOL (${signature.substring(0, 12)}...)`);

    } catch (error) {
      console.log(`❌ Кошелёк ${walletNum}/${wallets.length}: ${error.message}`);
      stats.skipped++;
    }

    stats.processed++;

    // Задержка между кошельками
    if (i < wallets.length - 1) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_BETWEEN_WALLETS));
    }
  }

  // Итоги
  console.log('\n' + '═'.repeat(80));
  console.log('🎉 СБОР ЗАВЕРШЕН!');
  console.log('═'.repeat(80));
  console.log(`📊 Обработано: ${stats.processed}/${wallets.length}`);
  console.log(`✅ Отправлено транзакций: ${stats.successful}`);
  console.log(`⚪ Пропущено: ${stats.skipped}`);
  console.log(`💰 СОБРАНО: ${stats.totalCollected.toFixed(6)} SOL`);
  console.log(`💸 Комиссий: ~${stats.totalFees.toFixed(6)} SOL`);
  console.log(`📍 Получатель: ${recipientPubkey.toString()}`);
}

// ===== ГЛАВНОЕ МЕНЮ =====

async function mainMenu() {
  console.log('\n' + '═'.repeat(80));
  console.log('🚀 SOLANA TOKEN ACCOUNT CLOSER');
  console.log('═'.repeat(80));
  console.log('\nВыберите режим:');
  console.log('1. CHECK   - Проверить кошельки (сколько можно вернуть)');
  console.log('2. FUND    - Раздать SOL на eligible кошельки (для комиссий)');
  console.log('3. CLAIM   - Вернуть SOL с Token Accounts');
  console.log('4. COLLECT - Собрать всю SOL на один кошелек');
  console.log('5. Выход\n');

  const rl = createInterface();
  const choice = await question(rl, 'Ваш выбор (1-5): ');
  rl.close();

  console.log('');

  switch (choice.trim()) {
    case '1':
      await checkMode();
      break;
    case '2':
      await fundMode();
      break;
    case '3':
      await claimMode();
      break;
    case '4':
      await collectMode();
      break;
    case '5':
      console.log('👋 До свидания!');
      process.exit(0);
    default:
      console.log('❌ Неверный выбор!');
      await mainMenu();
  }

  console.log('\n');
  await mainMenu();
}

// Запуск
mainMenu().catch(error => {
  console.error('💥 Критическая ошибка:', error);
  process.exit(1);
});
