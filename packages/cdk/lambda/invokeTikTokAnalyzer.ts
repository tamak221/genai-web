import { Logger } from '@aws-lambda-powertools/logger';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { findTeamById, findTeamPremiumStatusById } from './repository/teamRepository';
import { COMMON_TEAM_ID } from './utils/constants';
import { createResponse } from './utils/http';
import { HttpError } from './utils/httpError';
import { isSystemAdmin, isTeamUser } from './utils/teamRole';
import { truncate } from './utils/truncate';

const logger = new Logger();

type TikTokAnalyzeRequest = {
  teamId: string;
  url: string;
  timeoutMs?: number;
};

type TikTokAnalyzeResult = {
  teamId: string;
  url: string;
  finalUrl: string;
  likeCount: string;
  shareCount: string;
  caption: string;
  analysisPrompt: string;
  analyzedAt: string;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.TIKTOK_ANALYZER_DEFAULT_TIMEOUT_MS ?? 30_000);
const MAX_TIMEOUT_MS = Number(process.env.TIKTOK_ANALYZER_MAX_TIMEOUT_MS ?? 90_000);
const PREMIUM_FEATURE_FLAG_KEY =
  process.env.TIKTOK_ANALYZER_PREMIUM_FEATURE_FLAG_KEY ?? 'tiktokAnalyzer';

type ChromiumLaunchConfig = {
  executablePath?: string;
  args?: string[];
  headless: boolean | 'shell';
};

const parseAndValidateRequest = (event: APIGatewayProxyEvent): TikTokAnalyzeRequest => {
  if (!event.body) {
    throw new HttpError(400, 'bodyがありません。');
  }

  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = JSON.parse(event.body);
  } catch {
    throw new HttpError(400, 'リクエストボディのJSON形式が不正です。');
  }

  const url = parsedBody.url;
  const timeoutMsRaw = parsedBody.timeoutMs;
  const teamId = parsedBody.teamId;

  if (typeof teamId !== 'string' || teamId.trim().length === 0) {
    throw new HttpError(400, 'teamIdは必須です。');
  }

  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new HttpError(400, 'urlは必須です。');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new HttpError(400, 'urlの形式が不正です。');
  }

  if (!/^https?:$/.test(parsedUrl.protocol)) {
    throw new HttpError(400, 'urlはhttp/httpsのみ指定できます。');
  }

  const timeoutMs =
    typeof timeoutMsRaw === 'number' && Number.isFinite(timeoutMsRaw)
      ? Math.min(Math.max(Math.floor(timeoutMsRaw), 1_000), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

  return {
    teamId,
    url: parsedUrl.toString(),
    timeoutMs,
  };
};

const loadDynamicModule = async <T>(moduleName: string): Promise<T | null> => {
  const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
  try {
    return (await dynamicImport(moduleName)) as T;
  } catch {
    return null;
  }
};

const resolveChromiumLaunchConfig = async (): Promise<ChromiumLaunchConfig> => {
  const sparticuzChromium = await loadDynamicModule<any>('@sparticuz/chromium');
  if (sparticuzChromium) {
    const executablePath = await sparticuzChromium.executablePath();
    return {
      executablePath,
      args: sparticuzChromium.args ?? [],
      headless: sparticuzChromium.headless ?? true,
    };
  }

  const chromeAwsLambda = await loadDynamicModule<any>('chrome-aws-lambda');
  if (chromeAwsLambda) {
    const executablePath = await chromeAwsLambda.executablePath;
    return {
      executablePath: executablePath ?? undefined,
      args: chromeAwsLambda.args ?? [],
      headless: chromeAwsLambda.headless ?? true,
    };
  }

  // ローカル実行など、Lambda専用Chromiumが使えない環境向けフォールバック
  return {
    headless: true,
    args: [],
  };
};

const buildAnalysisPrompt = (params: {
  url: string;
  likeCount: string;
  shareCount: string;
  caption: string;
}): string => {
  return [
    'あなたはSNS動画分析の専門家です。以下のTikTok動画情報を分析してください。',
    '',
    `URL: ${params.url}`,
    `いいね数: ${params.likeCount || '不明'}`,
    `シェア数: ${params.shareCount || '不明'}`,
    `キャプション: ${params.caption || '不明'}`,
    '',
    '出力要件:',
    '1. 投稿の主題と訴求ポイント（3点以内）',
    '2. エンゲージメント仮説（いいね/シェア数の観点）',
    '3. 想定ターゲット層',
    '4. 改善提案（次の投稿に活かせる具体策を3点）',
  ].join('\n');
};

const analyzeTikTokUrl = async (request: TikTokAnalyzeRequest): Promise<TikTokAnalyzeResult> => {
  const playwrightCore = await loadDynamicModule<any>('playwright-core');
  if (!playwrightCore?.chromium) {
    throw new Error('playwright-core is not available.');
  }

  const launchConfig = await resolveChromiumLaunchConfig();
  const browser = await playwrightCore.chromium.launch(launchConfig);

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    page.setDefaultTimeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    await page.goto(request.url, { waitUntil: 'domcontentloaded' });

    // TikTok の遅延描画を考慮して最低限の待機を入れる（必要に応じて調整）。
    await page.waitForTimeout(1_500);
    await page.waitForSelector('[data-e2e="browse-video-desc"]', {
      timeout: Math.min(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10_000),
    });

    const result = await page.evaluate(() => {
      const getText = (selector: string): string =>
        document.querySelector(selector)?.textContent?.trim() ?? '';

      const likeCount = getText('[data-e2e="like-count"]');
      const shareCount = getText('[data-e2e="share-count"]');
      const caption = getText('[data-e2e="browse-video-desc"]');

      return {
        finalUrl: window.location.href,
        likeCount,
        shareCount,
        caption,
      };
    });

    await context.close();

    const analysisPrompt = buildAnalysisPrompt({
      url: result.finalUrl || request.url,
      likeCount: result.likeCount,
      shareCount: result.shareCount,
      caption: result.caption,
    });

    return {
      teamId: request.teamId,
      url: request.url,
      finalUrl: result.finalUrl,
      likeCount: result.likeCount,
      shareCount: result.shareCount,
      caption: result.caption,
      analysisPrompt,
      analyzedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const request = parseAndValidateRequest(event);
    const team = await findTeamById(request.teamId);
    if (!team) {
      throw new HttpError(404, 'チームが見つかりませんでした。');
    }

    const isTeamUserResult = await isTeamUser(event, request.teamId);
    const isCommonOrTeamUser = request.teamId === COMMON_TEAM_ID || isTeamUserResult;
    if (!isSystemAdmin(event) && !isCommonOrTeamUser) {
      throw new HttpError(403, 'このチームのTikTok分析機能を実行する権限がありません。');
    }

    const isPremium = await findTeamPremiumStatusById(request.teamId);
    if (!isPremium) {
      throw new HttpError(
        403,
        `この機能は有料契約チーム限定です。チーム設定（${PREMIUM_FEATURE_FLAG_KEY}）をご確認ください。`,
      );
    }

    const output = await analyzeTikTokUrl(request);

    return createResponse(
      200,
      JSON.stringify({
        outputs: output,
      }),
    );
  } catch (error) {
    if (error instanceof HttpError) {
      logger.warn('Invalid request for invokeTikTokAnalyzer', {
        statusCode: error.statusCode,
        message: error.message,
      });
      return createResponse(error.statusCode, JSON.stringify({ outputs: error.message }));
    }

    logger.error('Error in invokeTikTokAnalyzer', {
      error: truncate((error as Error)?.message ?? 'Unknown error'),
    });

    return createResponse(
      500,
      JSON.stringify({
        outputs: 'TikTok解析中にサーバエラーが発生しました。',
      }),
    );
  }
};
