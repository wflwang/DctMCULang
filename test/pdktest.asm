;//@@@NY inst###

#define a   r0
#include "../pad.inc"
//ddd
;
ad10 equ    d87
#define d87 bb3
#define bb3 y38
y38 equ 39+5
ccb equ 33
#define ddd bbb
#define bbb 200
porta equ  0x04|1
#define PIN_333 porta,3
temp    equ     390

    ORG 0x1000

    goto       LOOP
ifdef dd
    mov     a,1
    MOV     3
    sb      33,a`
    goto    LOOP
    stt16   
    ldt16
    movia   33
endif
#if 1
LOOP:
    bcr     PIN_333
    movia   ad10
    movia   ddd
    xorar   ad10,0
    movar   ad10
    xoria   ad10
    addar   ad10,1
    adcar   ad10,1
    return
    retia   3
    retie
    subar   add10,0
    sbcar   add10,0
    comr    add10,1
    subar   bbb,0
    movr    ccc,0
    mov     a,1
    mov     a,temp
    MOV     3
    sb      33,a`
    goto    LOOP
    stt16   
    ldt16
    movia   33
#endif
MAIN:
    wdreset
    goto        MAIN_LOOP:
    call        
    call            MAIN
    goto        MAIN
    xch     
    comp    a,3
    ceqsn   d
    wdreset 3
    reset
    nadd    a,33
    add     a,1
    subc        aa
