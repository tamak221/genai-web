import { type MenuItemProps } from '@/components/ui/Drawer';
import { createElement } from 'react';
import { PiChartBar } from 'react-icons/pi';

export const GEN_U_MENU_ITEMS: MenuItemProps[] = [
  {
    label: 'チャット',
    to: '/chat',
  },
  {
    label: 'TikTok分析',
    to: '/tiktok-analyzer',
    icon: createElement(PiChartBar, { className: 'text-lg' }),
  },
  {
    label: '文章を生成',
    to: '/generate',
  },
  {
    label: '翻訳',
    to: '/translate',
  },
  {
    label: '音声ファイルから文字起こし',
    to: '/transcribe',
  },
] as const satisfies MenuItemProps[];
