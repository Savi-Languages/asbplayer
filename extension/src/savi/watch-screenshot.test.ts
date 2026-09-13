jest.mock('@project/common/src/image-transformer',()=>({cropAndResize:jest.fn(async()=> 'data:image/jpeg;base64,/9j/2Q==')}));
import { captureWatchScreenshot } from './watch-screenshot';
import { cropAndResize } from '@project/common/src/image-transformer';
const setup=()=>{
 const video=document.createElement('video');
 Object.defineProperty(video,'paused',{value:true});
 video.getBoundingClientRect=()=>({left:10,top:10,width:300,height:200,right:310,bottom:210} as DOMRect);
 return video;
};
afterEach(()=>jest.clearAllMocks());
test('captures only the player region for a still-current paused moment',async()=>{
 const send=jest.fn(async()=>({dataUrl:'data:image/jpeg;base64,/9j/2Q=='}));
 expect(await captureWatchScreenshot(setup(),send,()=>true)).toBe('data:image/jpeg;base64,/9j/2Q==');
 expect(send).toHaveBeenCalledWith({command:'savi-capture-frame'});
 expect(cropAndResize).toHaveBeenCalledWith(640,0,{left:10,top:10,width:300,height:200},expect.any(String));
});
test('drops the image when the scene changes during capture; save can continue without it',async()=>{
 let current=true;const send=jest.fn(async()=>{current=false;return {dataUrl:'data:image/jpeg;base64,/9j/2Q=='};});
 expect(await captureWatchScreenshot(setup(),send,()=>current)).toBeUndefined();
 expect(cropAndResize).not.toHaveBeenCalled();
});
test('never captures an offscreen or hidden player',async()=>{
 const video=setup();video.getBoundingClientRect=()=>({left:-50,top:0,width:300,height:200,right:250,bottom:200} as DOMRect);
 const send=jest.fn();expect(await captureWatchScreenshot(video,send,()=>true)).toBeUndefined();expect(send).not.toHaveBeenCalled();
});
