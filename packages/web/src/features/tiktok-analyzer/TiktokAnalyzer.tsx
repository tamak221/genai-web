import { ListTeamsResponse, Team } from 'genai-web';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { PageTitle } from '@/components/PageTitle';
import { Button } from '@/components/ui/dads/Button';
import { ErrorText } from '@/components/ui/dads/ErrorText';
import { Input } from '@/components/ui/dads/Input';
import { Label } from '@/components/ui/dads/Label';
import { LoadingButton } from '@/components/ui/LoadingButton';
import { APP_TITLE } from '@/constants';
import { isApiError, teamApi } from '@/lib/fetcher';
import { LayoutBody } from '@/layout/LayoutBody';

type TikTokAnalyzeResponse = {
  outputs?: {
    teamId: string;
    url: string;
    likeCount: string;
    shareCount: string;
    caption: string;
    analysisPrompt: string;
  };
};

export const TiktokAnalyzer = () => {
  const navigate = useNavigate();
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [url, setUrl] = useState('');
  const [analysisPrompt, setAnalysisPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingTeams, setIsLoadingTeams] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const loadTeams = async () => {
      try {
        setIsLoadingTeams(true);
        const res = await teamApi.get<ListTeamsResponse>('teams');
        const fetchedTeams = res.data.teams ?? [];
        setTeams(fetchedTeams);
        if (fetchedTeams.length > 0) {
          setSelectedTeamId(fetchedTeams[0].teamId);
        }
      } catch (e) {
        if (isApiError(e)) {
          setError((e.data as { error?: string })?.error ?? 'チーム一覧の取得に失敗しました。');
        } else {
          setError('チーム一覧の取得に失敗しました。');
        }
      } finally {
        setIsLoadingTeams(false);
      }
    };
    loadTeams();
  }, []);

  const selectedTeam = useMemo(
    () => teams.find((team) => team.teamId === selectedTeamId),
    [teams, selectedTeamId],
  );

  const isPremiumTeam = Boolean(selectedTeam?.isPremium);
  const showPremiumMessage = selectedTeamId !== '' && !isPremiumTeam;

  const handleAnalyze = async () => {
    if (!selectedTeamId || !url.trim()) {
      setError('チームとTikTok URLを入力してください。');
      return;
    }
    if (!isPremiumTeam) {
      setError('この機能はプレミアムプラン限定です');
      return;
    }

    try {
      setError('');
      setIsLoading(true);
      const res = await teamApi.post<TikTokAnalyzeResponse>('tiktok/analyze', {
        teamId: selectedTeamId,
        url: url.trim(),
      });
      const prompt = res.data.outputs?.analysisPrompt ?? '';
      if (!prompt) {
        setError('分析プロンプトの生成に失敗しました。');
        return;
      }
      setAnalysisPrompt(prompt);
    } catch (e) {
      if (isApiError(e)) {
        if (e.status === 403) {
          setError(
            'この機能はプレミアムプラン限定です。アップグレードをご検討ください',
          );
          return;
        }
        const apiMessage = ((e.data as { error?: string; outputs?: string })?.error ??
          (e.data as { outputs?: string })?.outputs ??
          '') as string;
        setError(apiMessage || 'TikTok分析の実行に失敗しました。');
      } else {
        setError('TikTok分析の実行に失敗しました。');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <LayoutBody>
      <PageTitle title={`TikTok分析${APP_TITLE ? ` | ${APP_TITLE}` : ''}`} />
      <div className='mx-6 max-w-[calc(1024/16*1rem)] py-6 pb-12 lg:mx-10 lg:pb-16'>
        <h1 className='mb-4 text-std-20B-160 lg:text-std-24B-150'>
          TikTokバズり分析（プレミアム限定）
        </h1>

        <div className='flex flex-col gap-4'>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='tiktok-team'>対象チーム</Label>
            <select
              id='tiktok-team'
              className='h-11 rounded-6 border border-solid-gray-600 bg-white px-3'
              value={selectedTeamId}
              onChange={(e) => setSelectedTeamId(e.target.value)}
              disabled={isLoadingTeams || teams.length === 0}
            >
              {teams.map((team) => (
                <option key={team.teamId} value={team.teamId}>
                  {team.teamName}
                </option>
              ))}
            </select>
          </div>

          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='tiktok-url'>TikTok URL</Label>
            <Input
              id='tiktok-url'
              type='url'
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder='https://www.tiktok.com/@user/video/...'
            />
          </div>

          {showPremiumMessage && (
            <ErrorText id='premium-plan-message'>
              この機能はプレミアムプラン限定です。アップグレードをご検討ください
            </ErrorText>
          )}

          {error && <ErrorText id='tiktok-analyzer-error'>{error}</ErrorText>}

          <div className='mt-2'>
            <LoadingButton
              type='button'
              variant='solid-fill'
              size='lg'
              className='w-60'
              loading={isLoading}
              onClick={handleAnalyze}
              disabled={isLoadingTeams || !selectedTeamId || !url.trim() || !isPremiumTeam}
            >
              {isLoading ? '分析中...' : '分析開始'}
            </LoadingButton>
          </div>

          {analysisPrompt && (
            <div className='mt-4 rounded-6 border border-solid-gray-420 p-4'>
              <p className='mb-2 text-oln-16B-100'>生成された分析プロンプト</p>
              <pre className='whitespace-pre-wrap text-dns-16N-130'>{analysisPrompt}</pre>
              <div className='mt-4'>
                <Button
                  variant='outline'
                  size='md'
                  onClick={() =>
                    navigate('/chat?autoSubmit=true', {
                      state: { content: analysisPrompt },
                    })
                  }
                >
                  チャットで分析を続ける
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </LayoutBody>
  );
};
