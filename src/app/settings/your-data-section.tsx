"use client";

import Link from "next/link";
import { useAuth } from "../auth/auth-provider";
import { useQuestStore } from "../quest-store";

export const privacyContactEmail = "hello.plantetary@gmail.com";

/**
 * Where this player's information is kept, how to take a copy or remove it, and how to ask for an
 * account to be deleted. It only points to what already exists: Export and Reset (Data management, just
 * below) and the Privacy Notice. Account deletion is by email, done by hand; nothing here deletes anything.
 *
 * Deletion instructions are shown only to a verified signed-in player. Anyone else (a guest, someone
 * signed out, or a sign-in that couldn't be confirmed) sees how browser data works, and a pointer to the
 * Privacy Notice for anyone who has an account, without suggesting they do.
 */
export default function YourDataSection() {
  const { auth } = useAuth();
  const { storage } = useQuestStore();
  const signedIn = auth.status === "signed-in";
  const cloud = signedIn && storage.mode === "cloud";
  // Still choosing on the "Start your cloud garden?" card: the account has no cloud garden yet.
  const noCloudGardenYet = cloud && storage.phase === "choose";
  // As the Reset button itself: off while the cloud is the storage.
  const resetAvailable = storage.mode !== "cloud";

  return (
    <section className="settings-section your-data" aria-labelledby="settings-your-data-heading">
      <h2 id="settings-your-data-heading">Your data</h2>
      {noCloudGardenYet ? (
        <p className="settings-description">
          You&apos;re signed in, and your account doesn&apos;t have a cloud garden yet. Your browser garden stays in this browser
          unless you choose to import it. Your profile and reminder settings stay in this browser on this device.
        </p>
      ) : cloud ? (
        <p className="settings-description">
          Your garden is saved to your Plantetary account, with its backups. Your profile and reminder settings stay in this
          browser on this device.
        </p>
      ) : signedIn ? (
        <p className="settings-description">
          You&apos;re playing the garden saved in this browser on this device, so nothing is being saved to your account. Your
          profile and reminder settings stay in this browser too.
        </p>
      ) : (
        <p className="settings-description">
          Your garden, profile and reminder settings are saved in this browser on this device. They aren&apos;t sent to
          Plantetary unless you sign in and choose to use a cloud garden.
        </p>
      )}
      <p className="settings-description">
        To keep a copy, use <strong>Export data as JSON</strong> in Data management below: it downloads the garden you&apos;re
        playing, with your profile and reminder settings.
        {resetAvailable && <> To remove it from this device, use <strong>Reset Plantetary data</strong>, or clear this site&apos;s data in your browser.</>}
      </p>
      {signedIn ? (
        <div className="your-data-deletion">
          <h3>Deleting your account</h3>
          <p className="settings-description">
            Deleting your account is different from resetting this browser. To delete your Plantetary account, with its cloud
            garden and backups, email{" "}
            <a className="text-link" href={`mailto:${privacyContactEmail}`}>{privacyContactEmail}</a> from{" "}
            <strong className="account-email">{auth.user.email ?? "the email address you sign in with"}</strong> and say
            you&apos;d like it deleted. It&apos;s done by hand once we&apos;ve checked the request is yours, so it isn&apos;t
            immediate. The data saved in this browser stays here until you reset it or clear it.
          </p>
          <p className="settings-description">
            You can also email to ask for a copy of the information connected to your account, or to correct something
            that&apos;s inaccurate. We aim to complete verified requests within 30 days.
          </p>
        </div>
      ) : (
        <p className="settings-description">
          If you have a Plantetary account, the Privacy Notice explains how to ask for it to be deleted.
        </p>
      )}
      <p className="settings-description your-data-privacy">
        <Link className="text-link" href="/privacy">Read the Privacy Notice</Link> to see what Plantetary keeps, where, and for how long.
      </p>
    </section>
  );
}
