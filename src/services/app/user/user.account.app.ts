import { injectable, inject } from 'inversify';
import { getConnection } from 'typeorm';
import * as bcrypt from 'bcrypt-nodejs';

import * as util from 'util';
import config from '../../../config';

import { AuthClientType, AuthClientInterface } from '../../external/auth.client';
import { VerificationClientType, VerificationClientInterface } from '../../external/verify.client';
import { Web3ClientType, Web3ClientInterface } from '../../external/web3.client';
import { EmailQueueType, EmailQueueInterface } from '../../queues/email.queue';

import successSignUpTemplate from '../../../resources/emails/2_success_signup';
import successSignInTemplate from '../../../resources/emails/5_success_signin';

import {
  UserExists,
  UserNotFound,
  InvalidPassword,
  TokenNotFound,
  AuthenticatorError,
  IncorrectMnemonic,
  WalletNotFound
} from '../../../exceptions';
import { User } from '../../../entities/user';
import { VerifiedToken } from '../../../entities/verified.token';
import * as transformers from '../transformers';
import { generateMnemonic, MasterKeySecret, getUserMasterKey, encryptText, getRecoveryMasterKey, getSha256Hash, decryptTextByUserMasterKey } from '../../crypto';
import { Logger, SubLogger } from '../../../logger';
import { UserRepositoryType, UserRepositoryInterface } from '../../repositories/user.repository';
import { RegisteredTokenRepository, RegisteredTokenRepositoryType, RegisteredTokenRepositoryInterface, RegisteredTokenScope } from '../../repositories/registered.tokens.repository';
import { buildScopeEmailVerificationInitiate, buildScopeGoogleAuthVerificationInitiate } from '../../../verify.cases';
import { VerificationInitiateContext } from '../../external/verify.context.service';
import { Wallet } from '../../../entities/wallet';
import { VerifyActionServiceType, VerifyActionService, Verifications, VerifyMethod, getAllVerifications } from '../../external/verify.action.service';
import { Token } from '../../../entities/token';
import { writeFile, mkdir } from 'fs';
import { join } from 'path';
import { Notifications, Preferences, getAllNotifications, BooleanState } from '../../../entities/preferences';

const writeFilePromised = util['promisify'](writeFile);
const makeDirPromised = util['promisify'](mkdir);

/**
 * UserAccountApplication
 */
@injectable()
export class UserAccountApplication {
  private logger = Logger.getInstance('USER_ACCOUNT_APP');

  /**
   * constructor
   */
  constructor(
    @inject(VerifyActionServiceType) private verifyAction: VerifyActionService,
    @inject(AuthClientType) private authClient: AuthClientInterface,
    @inject(UserRepositoryType) private userRepository: UserRepositoryInterface,
    @inject(RegisteredTokenRepositoryType) private tokensRepository: RegisteredTokenRepositoryInterface,
    @inject(Web3ClientType) private web3Client: Web3ClientInterface,
    @inject(EmailQueueType) private emailQueue: EmailQueueInterface
  ) { }

  // @TODO: DRY
  private newInitiateVerification(scope: string, consumer: string) {
    return buildScopeGoogleAuthVerificationInitiate(
      new VerificationInitiateContext(scope), { consumer }
    );
  }

  private async initiateCreateAndReturnUser(logger: SubLogger, user: User, initiateVerification: VerificationInitiateContext) {
    logger.debug('Initiate verification');

    const { verifyInitiated } = await this.verifyAction.initiate(initiateVerification, {
      userEmail: user.email
    });

    return transformers.transformCreatedUser(user, verifyInitiated);
  }

  private async createNewWallet(logger: SubLogger, user: User, paymentPassword: string, inputWallet: InputWallet) {
    logger.debug('Create new wallet');

    // should be created every time for fresh master key
    const msc = new MasterKeySecret();

    let mnemonic = generateMnemonic();
    let salt = bcrypt.genSaltSync();

    if (user.securityKey && user.wallets.length) {
      logger.debug('Derive new wallet');

      mnemonic = decryptTextByUserMasterKey(msc, user.mnemonic, paymentPassword, user.securityKey);
      if (!mnemonic) {
        throw new IncorrectMnemonic('Incorrect payment password');
      }

      salt = decryptTextByUserMasterKey(msc, user.salt, paymentPassword, user.securityKey);
      if (!salt) {
        throw new IncorrectMnemonic('Incorrect payment password, invalid address');
      }
    } else {
      logger.debug('First creation of wallet');

      const mscRecoveryKey = new MasterKeySecret();
      mscRecoveryKey.key = Buffer.from(config.crypto.globalKey, 'hex');

      const recoveryKey = getRecoveryMasterKey(msc);
      user.recoveryKey = JSON.stringify({
        mac: mscRecoveryKey.encrypt(recoveryKey.mac).toString('base64'),
        pubkey: mscRecoveryKey.encrypt(recoveryKey.pubkey).toString('base64'),
        msg: mscRecoveryKey.encrypt(recoveryKey.msg).toString('base64')
      });
      user.securityKey = getUserMasterKey(msc, paymentPassword);
      user.salt = encryptText(msc, salt);
      user.mnemonic = encryptText(msc, mnemonic);
    }

    const walletIndex = user.getNextWalletIndex();
    const account = this.web3Client.getAccountByMnemonicAndSalt(mnemonic, salt, walletIndex);

    const newWallet = Wallet.createWallet({
      ticker: 'ETH',
      address: account.address,
      balance: '0',
      tokens: [],
      name: inputWallet.name,
      color: inputWallet.color
    });
    newWallet.index = walletIndex;
    logger.debug("Wallet index: " + walletIndex);

    user.addWallet(newWallet);
    logger.debug("Wallets: ", user.wallets);
    await this.userRepository.save(user);

    return newWallet;
  }

  /**
   * Save user's data
   * Note! Use throttler or captcha to prevent spam
   *
   * @param userData user info
   * @return promise
   */
  async create(userData: InputUserData): Promise<CreatedUserData> {
    // it better to use collate in mongo index
    userData.email = userData.email.toLowerCase();

    if (userData.password === userData.paymentPassword) {
      throw new InvalidPassword('Login and payment passwords are matched');
    }

    const initiateVerification = buildScopeEmailVerificationInitiate(
      this.newInitiateVerification(Verifications.USER_SIGNUP, userData.email),
      { email: userData.email, name: userData.name }
    );

    const { email } = userData;
    const existingUser = await getConnection().getMongoRepository(User).findOne({ email });

    if (existingUser) {
      if (!existingUser.isVerified && bcrypt.compareSync(userData.password, existingUser.passwordHash)) {
        return this.initiateCreateAndReturnUser(this.logger.sub({ email }, '[create] '), existingUser, initiateVerification);
      } else {
        throw new UserExists('User already exists');
      }
    }

    const logger = this.logger.sub({ email }, '[create] ');

    logger.debug('Create and save a new user');

    const user = User.createUser({
      email,
      name: userData.name,
      agreeTos: userData.agreeTos,
      source: userData.source
    });
    user.passwordHash = bcrypt.hashSync(userData.password);


    logger.debug('Save user');

    await this.userRepository.save(user);

    return this.initiateCreateAndReturnUser(logger, user, initiateVerification);
  }

  private async addGlobalRegisteredTokens(logger: SubLogger, user: User, wallet: Wallet) {
    logger.debug('Fill known global tokens and set verified');

    const registeredTokens = await this.tokensRepository.getAllByScope(RegisteredTokenScope.Global);

    wallet.tokens = registeredTokens.map(rt => Token.createToken({
      contractAddress: rt.contractAddress,
      symbol: rt.symbol,
      name: rt.name,
      decimals: rt.decimals
    }));
  }

  private getRecoveryNameForUser(user: User): string {
    return `${user.id.toHexString()}_${getSha256Hash(new Buffer(user.email, 'utf-8')).toString('hex').slice(0, 24)}`;
  }

  // @TODO: remove
  private async saveRecoveryKey(recoveryKey: any, user: User): Promise<void> {
    const recoveryFileName = this.getRecoveryNameForUser(user);
    // @TODO: Save in more safe space
    return makeDirPromised(
      join(
        config.crypto.recoveryFolder,
        recoveryFileName.slice(-2)
      )
    ).catch(() => { /* skip */ })
      .then(() => {
        return writeFilePromised(
          join(
            config.crypto.recoveryFolder,
            recoveryFileName.slice(-2),
            recoveryFileName
          ),
          JSON.stringify(recoveryKey)
        );
      });
  }

  private async activateUser(logger: SubLogger, user: User): Promise<void> {
    logger.debug('Save verified user state');

    user.isVerified = true;

    await this.userRepository.save(user);

  }

  /**
   *
   * @param activationData
   */
  async activate(verify: VerificationInput): Promise<ActivationResult> {
    this.logger.debug('[activate]');

    const { verifyPayload } = await this.verifyAction.verify(Verifications.USER_SIGNUP, verify.verification);

    const user = await getConnection().getMongoRepository(User).findOne({
      email: verifyPayload.userEmail
    });

    if (!user) {
      throw new UserNotFound('User is not found', {
        email: verifyPayload.userEmail
      });
    }
    if (user.isVerified) {
      throw new UserExists('User already verified');
    }

    const logger = this.logger.sub({ email: user.email }, '[activate] ');

    logger.debug('Register new user in auth service');

    await this.authClient.createUser(transformers.transformUserForAuth(user));

    logger.debug('Get auth token from auth service');

    const loginResult = await this.authClient.loginUser({
      login: user.email,
      password: user.passwordHash,
      deviceId: 'device'
    });

    await this.activateUser(logger, user);

    logger.debug('Save verified token');

    const token = VerifiedToken.createVerifiedToken(user, loginResult.accessToken);
    await getConnection().getMongoRepository(VerifiedToken).save(token);

    this.emailQueue.addJob({
      sender: config.email.from.general,
      recipient: user.email,
      subject: 'You are confirmed your account',
      text: successSignUpTemplate(user.name)
    });

    return {
      accessToken: token.token
    };
  }

  /**
   * Save user's data
   *
   * @param loginData user info
   * @param ip string
   * @return promise
   */
  async initiateLogin(loginData: InitiateLoginInput, ip: string): Promise<InitiateLoginResult> {
    // it better to use collate in mongo index
    loginData.email = loginData.email.toLowerCase();

    const user = await getConnection().getMongoRepository(User).findOne({
      email: loginData.email
    });

    if (!user || !user.isVerified) {
      throw new UserNotFound('User is not found or not activated');
    }

    if (!bcrypt.compareSync(loginData.password, user.passwordHash)) {
      throw new InvalidPassword('Incorrect password');
    }

    const logger = this.logger.sub({ email: user.email }, '[initiateLogin] ');

    logger.debug('Login in auth service');

    const tokenData = await this.authClient.loginUser({
      login: user.email,
      password: user.passwordHash,
      deviceId: 'device'
    });

    logger.debug('Initiate verification');

    const initiateVerification = this.newInitiateVerification(Verifications.USER_SIGNIN, user.email);
    if (user.defaultVerificationMethod === VerifyMethod.EMAIL) {
      buildScopeEmailVerificationInitiate(
        initiateVerification,
        { ip, user }
      );
    }

    if (!user.isVerificationEnabled(Verifications.USER_SIGNIN)) {
      initiateVerification.setMethod(VerifyMethod.INLINE);
    }

    const { verifyInitiated } = await this.verifyAction.initiate(initiateVerification, {
      userName: user.name,
      userEmail: user.email,
      accessToken: tokenData.accessToken
    });

    const token = VerifiedToken.createNotVerifiedToken(user, tokenData.accessToken);

    logger.debug('Save verified token');

    await getConnection().getMongoRepository(VerifiedToken).save(token);

    return {
      accessToken: tokenData.accessToken,
      isVerified: false,
      verification: verifyInitiated
    };
  }

  /**
   * Verify login
   *
   * @param inputData user info
   * @return promise
   */
  async verifyLogin(verify: VerificationInput): Promise<VerifyLoginResult> {
    this.logger.debug('[verifyLogin]');

    const { verifyPayload } = await this.verifyAction.verify(Verifications.USER_SIGNIN, verify.verification);

    const token = await getConnection().getMongoRepository(VerifiedToken).findOne({
      token: verifyPayload.accessToken
    });

    if (!token) {
      throw new TokenNotFound('Access token is not found for current user');
    }

    const logger = this.logger.sub({ email: verifyPayload.userEmail }, '[verifyLogin] ');

    logger.debug('Save verified login token', verifyPayload.userEmail);

    token.makeVerified();

    await getConnection().getMongoRepository(VerifiedToken).save(token);

    const user = (await getConnection().getMongoRepository(User).createEntityCursor({
      _id: token.userId
    }).toArray()).pop();
    if (!user) {
      throw new TokenNotFound('Access token is not any match with user');
    }

    if (user.isNotificationEnabled(Notifications.USER_SIGNIN)) {
      this.emailQueue.addJob({
        sender: config.email.from.general,
        subject: 'Successful Login Notification',
        recipient: verifyPayload.userEmail,
        text: successSignInTemplate(verifyPayload.userName, new Date().toUTCString())
      });
    }

    return transformers.transformVerifiedToken(token);
  }

  /**
   *
   * @param user
   * @param scope
   */
  private async initiateGoogleAuthVerification(logger: SubLogger, user: User, scope: Verifications): Promise<InitiatedVerification> {
    logger.debug('Initiate attempt to change GoogleAuth');

    const { verifyInitiated } = await this.verifyAction.initiate(this.newInitiateVerification(scope, user.email), {
      userEmail: user.email
    });

    return verifyInitiated;
  }

  /**
   *
   * @param user
   * @param scope
   * @param verify
   */
  private async verifyAndToggleGoogleAuth(logger: SubLogger, user: User, scope: Verifications, verify: VerificationInput): Promise<any> {
    logger.debug('Verify attempt to change GoogleAuth');

    const { verifyPayload } = await this.verifyAction.verify(scope, verify.verification, {
      removeSecret: scope === Verifications.USER_DISABLE_GOOGLE_AUTH
    });

    user.defaultVerificationMethod = scope === Verifications.USER_DISABLE_GOOGLE_AUTH ?
      VerifyMethod.EMAIL : VerifyMethod.AUTHENTICATOR;

    logger.debug('Save state GoogleAuth');

    await this.userRepository.save(user);

    return scope === Verifications.USER_ENABLE_GOOGLE_AUTH;
  }

  /**
   *
   * @param user
   */
  async initiateEnableGoogleAuth(user: User): Promise<BaseInitiateResult> {
    if (user.defaultVerificationMethod === VerifyMethod.AUTHENTICATOR) {
      throw new AuthenticatorError('GoogleAuth is enabled already.');
    }

    return {
      verification: await this.initiateGoogleAuthVerification(this.logger.sub({
        email: user.email
      }, '[initiateEnableGoogleAuth] '), user, Verifications.USER_ENABLE_GOOGLE_AUTH)
    };
  }

  /**
   *
   * @param user
   * @param params
   */
  async verifyEnableGoogleAuth(user: User, verify: VerificationInput): Promise<any> {
    if (user.defaultVerificationMethod === VerifyMethod.AUTHENTICATOR) {
      throw new AuthenticatorError('GoogleAuth is enabled already.');
    }

    return {
      enabled: await this.verifyAndToggleGoogleAuth(this.logger.sub({
        email: user.email
      }, '[verifyEnableGoogleAuth] '), user, Verifications.USER_ENABLE_GOOGLE_AUTH, verify)
    };
  }

  /**
   *
   * @param user
   */
  async initiateDisableGoogleAuth(user: User): Promise<BaseInitiateResult> {
    if (user.defaultVerificationMethod !== VerifyMethod.AUTHENTICATOR) {
      throw new AuthenticatorError('GoogleAuth is disabled already.');
    }

    return {
      verification: await this.initiateGoogleAuthVerification(this.logger.sub({
        email: user.email
      }, '[initiateDisableGoogleAuth] '), user, Verifications.USER_DISABLE_GOOGLE_AUTH)
    };
  }

  /**
   *
   * @param user
   * @param params
   */
  async verifyDisableGoogleAuth(user: User, verify: VerificationInput): Promise<any> {
    if (user.defaultVerificationMethod !== VerifyMethod.AUTHENTICATOR) {
      throw new AuthenticatorError('GoogleAuth is disabled already.');
    }

    return {
      enabled: await this.verifyAndToggleGoogleAuth(this.logger.sub({
        email: user.email
      }, '[verifyDisableGoogleAuth] '), user, Verifications.USER_DISABLE_GOOGLE_AUTH, verify)
    };
  }

  /**
   *
   * @param user
   */
  async setNotifications(user: User, notifications: BooleanState): Promise<any> {
    const logger = this.logger.sub({ email: user.email }, '[setNotifications] ');
    logger.debug('Set notifications');

    user.preferences = user.preferences || new Preferences();
    user.preferences.setNotifications(notifications);

    logger.debug('Save user notifications', { notifications: user.preferences.notifications });

    await this.userRepository.save(user);

    return {
      notifications: user.preferences.notifications
    };
  }

  /**
   *
   * @param user
   */
  async initiateSetVerifications(user: User, verifications: BooleanState): Promise<any> {
    this.logger.debug('[initiateSetVerifications]', { meta: { email: user.email } });

    const initiateVerification = this.newInitiateVerification(Verifications.USER_CHANGE_VERIFICATIONS, user.email);
    if (user.defaultVerificationMethod === VerifyMethod.EMAIL) {
      buildScopeEmailVerificationInitiate(
        initiateVerification,
        { user }
      );
    }

    const { verifyInitiated } = await this.verifyAction.initiate(initiateVerification, {
      verifications
    });

    return {
      verification: verifyInitiated
    };
  }

  /**
   *
   * @param user
   * @param params
   */
  async verifySetVerifications(user: User, verify: VerificationInput): Promise<any> {
    const logger = this.logger.sub({ email: user.email }, '[verifySetVerifications] ');

    logger.debug('Verify');

    const { verifyPayload } = await this.verifyAction.verify(Verifications.USER_CHANGE_VERIFICATIONS, verify.verification);

    user.preferences = user.preferences || new Preferences();
    user.preferences.setVerifications(verifyPayload.verifications);

    logger.debug('Save user verifications', { verifications: user.preferences.verifications });

    await this.userRepository.save(user);

    return {
      verifications: user.preferences.verifications
    };
  }

  /**
   *
   * @param user
   * @param type
   * @param paymentPassword
   * @param inputWallet
   */
  async createAndAddNewWallet(user: User, type: string, paymentPassword: string, inputWallet: InputWallet): Promise<any> {
    const logger = this.logger.sub({ email: user.email, type }, '[createAndAddNewWallet] ');
    logger.debug('Create and add');

    const newWallet = await this.createNewWallet(logger, user, paymentPassword, inputWallet);

    this.addGlobalRegisteredTokens(logger.addMeta({ walletAddress: newWallet.address }), user, newWallet);

    logger.debug('Save new wallet');

    await this.userRepository.save(user);

    const privateKey = config.test_fund.private_key;

    if (privateKey && config.app.env === 'stage' && newWallet.index == 0) {
      const account = this.web3Client.getAccountByPrivateKey(privateKey.toString());

      this.web3Client.sendTransactionByAccount({
        from: account.address.toString(),
        to: newWallet.address.toString(),
        amount: '0.1',
        gas: '21000',
        gasPrice: await this.web3Client.getCurrentGasPrice()
      }, account);
    }

    return {
      ticker: 'ETH',
      address: newWallet.address,
      balance: newWallet.balance,
      name: newWallet.name,
      color: newWallet.color
    }
  }

  /**
   *
   * @param user
   * @param inputWallet
   */
  async updateWallet(user: User, inputWallet: InputWallet): Promise<any> {
    const logger = this.logger.sub({ email: user.email }, '[updateWallet]');
    logger.debug('Update wallet');

    const wallet = user.getWalletByAddress(inputWallet.address);

    if (!wallet) {
      throw new WalletNotFound('Wallet not found');
    }

    const walletIndex = user.wallets.indexOf(wallet);
    wallet.updateWallet(inputWallet);

    user.updateWallet(walletIndex, wallet);

    logger.debug('Save updated wallet');

    await this.userRepository.save(user);

    return {
      ticker: wallet.ticker,
      address: wallet.address,
      balance: wallet.balance,
      name: wallet.name,
      color: wallet.color
    }
  }
}

const UserAccountApplicationType = Symbol('UserAccountApplicationInterface');
export { UserAccountApplicationType };
