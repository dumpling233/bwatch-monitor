import { isAllowedMonitorPage } from '../../shared/site';
declare const __BWATCH_LOCAL__: boolean;
export const LOCAL_BUILD = typeof __BWATCH_LOCAL__ !== 'undefined' && __BWATCH_LOCAL__;
export const allowedPage = (value: unknown, local = LOCAL_BUILD): boolean => isAllowedMonitorPage(value, local);
