/** Shared by the pre-runtime attribute fallback and runtime dispatch.
 * Own holds call the original method; subsequent listeners mark external cancels.
 * Keep the state on the event so bubbling generated listeners share one hold.
 */
export const confirmHold = `(e)=>{if(!e.__recoolerHold){if(e.defaultPrevented)return false;const p=e.preventDefault.bind(e);e.__recoolerHold={cancelled:false};p();e.preventDefault=()=>{e.__recoolerHold.cancelled=true;p()}}return !e.__recoolerHold.cancelled}`;
