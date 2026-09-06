import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { buildResumeDocx, docxToBuffer } from "@/lib/resumeDoc";
import { uploadToR2, getR2SignedUrl, objectKey } from "@/lib/r2";
import type { ResumeProfile, TailoredContent } from "@/lib/tailoring";

export const maxDuration = 30;

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function GET(request: NextRequest) {
  const supabase = createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const jobId = request.nextUrl.searchParams.get("jobId");
  const force = request.nextUrl.searchParams.get("regenerate") === "true";
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const [{ data: job, error: jobError }, { data: profileRow, error: profileError }] = await Promise.all([
    supabase.from("jobs").select("title, company, tailored_content, tailored_resume_path").eq("id", jobId).single(),
    supabase.from("resume_profile").select("*").eq("owner_id", user.id).single(),
  ]);

  if (jobError || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const safeCompany = job.company.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const filename = `resume-${safeCompany}.docx`;

  // Fast path: already generated and stored in R2, and caller isn't forcing
  // a fresh build (e.g. after editing resume_bullets).
  if (job.tailored_resume_path && !force) {
    const signedUrl = await getR2SignedUrl(job.tailored_resume_path);
    return NextResponse.json({ url: signedUrl, filename });
  }

  if (!job.tailored_content) {
    return NextResponse.json({ error: "No tailored resume has been generated for this job yet" }, { status: 404 });
  }
  if (profileError || !profileRow) {
    return NextResponse.json({ error: "No resume profile found for this account" }, { status: 404 });
  }

  const profile: ResumeProfile = {
    full_name: profileRow.full_name,
    headline: profileRow.headline,
    contact: profileRow.contact,
    summary: profileRow.summary,
    certifications: profileRow.certifications ?? [],
    education: profileRow.education ?? [],
    publications: profileRow.publications ?? [],
  };

  const tailored = job.tailored_content as TailoredContent;
  const doc = buildResumeDocx(profile, tailored);
  const buffer = await docxToBuffer(doc);

  const key = objectKey(user.id, jobId, "tailored_resume", ".docx");
  await uploadToR2(key, buffer, DOCX_CONTENT_TYPE);

  const { error: updateError } = await supabase
    .from("jobs")
    .update({ tailored_resume_path: key, documents_generated_at: new Date().toISOString() })
    .eq("id", jobId);

  if (updateError) {
    // Non-fatal: the file is in R2 and downloadable now, just not cached
    // for next time. Log and continue rather than failing the download.
    console.error("Failed to persist tailored_resume_path:", updateError);
  }

  const signedUrl = await getR2SignedUrl(key);
  return NextResponse.json({ url: signedUrl, filename });
}
