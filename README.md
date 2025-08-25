# ANON KODE



https://github.com/user-attachments/assets/7a9253a7-8bb0-40d5-a3f3-5e6096d7c789



# What's New?

* Tavity api is now available!

Terminal-based AI coding tool that can use any model that supports the OpenAI-style API.

* Fixes your spaghetti code
* Explains wtf that function does
* Runs tests, shell commands and stuff
* Whatever else claude-code can do, depending on the model you use

# HOW TO DEPLOY

make sure that you have installed bun:

curl -fsSL https://bun.sh/install | bash
then deploy it:



```

git clone https://github.com/maoruiQa/anon-kode-customised.git
cd anon-kode-customised
pnpm i
pnpm run dev
pnpm run build

```


the you can run it in any directory:

kode

Get some more logs while debugging:

NODE\_ENV=development pnpm run dev --verbose --debug

# BUGS

You can submit a bug from within the app with /bug, it will open a browser to github issue create with stuff filed out. But I don't sure if I can solve that. Because I can't even code with Nodejs, and I improved this project even 100% through GPT5 in Cursor.

## Warning

Use at own risk.



## YOUR DATA

* There's no telemetry or backend servers other than the AI providers you choose
