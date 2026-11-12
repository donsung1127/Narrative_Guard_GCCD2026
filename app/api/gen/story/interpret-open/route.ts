import {NextResponse} from 'next/server';
import {createHash} from 'node:crypto';
import {callAnthropicAPI} from '../../utils';
import {validateOpenContext,interpretOpenAction} from '@/lib/action-interpreter/open-core.mjs';
import {fromDramamancer} from '@/lib/action-interpreter/open-adapter.mjs';
// Interpretation only. Never accepts/returns an executable state patch.
export async function POST(request:Request){
 if(process.env.NODE_ENV!=='development'||process.env.OPEN_INTERPRETER_ENABLED!=='true')return NextResponse.json({error:'개방형 A 해석기 비활성'},{status:404});
 let context;
 try{
  const text=await request.text();if(text.length>256000)throw Error('request_too_large');
  const body=JSON.parse(text);
  context=body.source==='dramamancer'?fromDramamancer(body.input):validateOpenContext(body.context);
 }catch{return NextResponse.json({error:'공통 문맥 또는 시나리오 입력 형식 오류'},{status:400});}
 const startedAt=new Date().toISOString(),started=Date.now();let promptHash=''; let rawModelOutput:string|null=null;
 const result=await interpretOpenAction(context,async(systemPrompt,messages)=>{
  promptHash=createHash('sha256').update(systemPrompt).digest('hex');
  const generated = await callAnthropicAPI(
  systemPrompt,
  messages.map(m => ({
    role: m.role,
    content: [{type: 'text' as const, text: m.content}],
  })),
);

if (typeof generated !== 'string') {
  throw new Error('모델 응답이 문자열이 아닙니다.');
}

rawModelOutput = generated;
return generated;

 });
 return NextResponse.json({implementationVersion:'open-a-v01',mode:'interpretation_only',startedAt,durationMs:Date.now()-started,promptHash,context,result,...(result.status==='invalid_output'?{diagnostic:{rawModelOutput}}:{})});
}
